// Trek Buddy pendant: XIAO nRF52840 + Wio-SX1262 for XIAO
// Board: "Seeed XIAO nRF52840" (Seeed nRF52 Boards, not mbed)
// Libraries: RadioLib 7.8.1 (not 8.x), TinyGPSPlus
#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>
#include <TinyGPSPlus.h>
#include <bluefruit.h>

// ---- Pins (Wio-SX1262 for XIAO, as in Meshtastic's kit variant) ----
#define LORA_NSS   D4
#define LORA_DIO1  D1
#define LORA_RST   D2
#define LORA_BUSY  D3
#define LORA_RXEN  D5
#define PIN_BTN    D0
#define PIN_MOTOR  PIN_NFC1        // 30 = NFC1 pad (P0.09) on the back
// SPI (D8/D9/D10), Serial1 (D6 TX, D7 RX), LED_RED/GREEN/BLUE,
// PIN_VBAT and VBAT_ENABLE come from the Seeed board package.

// ---- Settings ----
const uint8_t  NODE_ID  = 2;       // CHANGE for every pendant (1, 2, ...)
const uint8_t  GROUP_ID = 7;
const uint32_t LOC_INTERVAL_MS = 30000;
const uint32_t SOS_RETRY_MS    = 5000;
const uint32_t LONG_PRESS_MS   = 3000;
const uint32_t ALERT_REPEAT_MS = 8000;  // receivers re-buzz this often until SOS ends

enum : uint8_t { T_LOC = 0, T_SOS = 1, T_ACK = 2 };
enum : uint8_t { F_SOS = 0x01, F_FALL = 0x02, F_LOWBAT = 0x04, F_NOFIX = 0x08 };

struct __attribute__((packed)) Packet {
  uint8_t  group, src;
  uint16_t seq;
  uint8_t  type, ttl;
  int32_t  lat, lon;               // degrees x 1e6 (an ACK puts the target ID in lat)
  uint8_t  batt, flags;
};
static_assert(sizeof(Packet) == 16, "Packet must be 16 bytes");

// Sent to the phone / laptop over BLE: the packet plus link quality
struct __attribute__((packed)) BlePacket {
  Packet pkt;
  int8_t rssi;                     // dBm, 0 for this pendant's own packets
  int8_t snr4;                     // SNR x 4 (dB)
};
static_assert(sizeof(BlePacket) == 18, "BlePacket must be 18 bytes");

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
TinyGPSPlus gps;

volatile bool rxFlag = false;
void onDio1() { rxFlag = true; }

uint16_t seqNo = 0;
bool sosActive = false;            // this pendant is asking for help
bool sosAcked  = false;            // someone heard it: stop resending
uint32_t lastLoc = 0, lastSos = 0, btnDown = 0;
bool btnHandled = false;
uint32_t sosNodes = 0;             // bit per node that currently has SOS active
uint32_t silenced = 0;             // SOS nodes this wearer has silenced (short press)
uint32_t lastAlert = 0;
volatile int8_t bleSosCmd = -1;    // set by the phone: 1 = start, 0 = cancel

// ---- BLE (Bluefruit) ----
// UUIDs 6e40000X-b5a3-f393-e0a9-e50e24dc7e01, written in reverse byte order
const uint8_t SVC_UUID[] = {0x01,0x7e,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
                            0x93,0xf3,0xa3,0xb5,0x01,0x00,0x40,0x6e};
const uint8_t POS_UUID[] = {0x01,0x7e,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
                            0x93,0xf3,0xa3,0xb5,0x02,0x00,0x40,0x6e};
const uint8_t SOS_UUID[] = {0x01,0x7e,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
                            0x93,0xf3,0xa3,0xb5,0x03,0x00,0x40,0x6e};
BLEService        trekSvc(SVC_UUID);
BLECharacteristic posChar(POS_UUID);
BLECharacteristic sosChar(SOS_UUID);

// ---- Use the NFC pads as normal GPIO (writes UICR once, then reboots) ----
void enableNfcPinsAsGpio() {
  if ((NRF_UICR->NFCPINS & UICR_NFCPINS_PROTECT_Msk) ==
      (UICR_NFCPINS_PROTECT_NFC << UICR_NFCPINS_PROTECT_Pos)) {
    NRF_NVMC->CONFIG = NVMC_CONFIG_WEN_Wen; while (!NRF_NVMC->READY);
    NRF_UICR->NFCPINS &= ~UICR_NFCPINS_PROTECT_Msk; while (!NRF_NVMC->READY);
    NRF_NVMC->CONFIG = NVMC_CONFIG_WEN_Ren; while (!NRF_NVMC->READY);
    NVIC_SystemReset();
  }
}

void led(int pin, bool on) { digitalWrite(pin, on ? LOW : HIGH); } // active LOW

void buzz(int ms) {
  digitalWrite(PIN_MOTOR, HIGH); delay(ms); digitalWrite(PIN_MOTOR, LOW);
}

// ---- Battery: onboard 1M / 510k divider on P0.31, 3.6 V ADC reference ----
uint8_t batteryPercent() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogRead(PIN_VBAT);
  float v = (sum / 8.0f) * 3.6f / 4096.0f * (1510.0f / 510.0f);
  return constrain((int)((v - 3.3f) / (4.2f - 3.3f) * 100), 0, 100);
}

// ---- Duplicate filter for relaying ----
uint32_t seen[32]; uint8_t seenIdx = 0;
bool alreadySeen(uint8_t src, uint16_t seq) {
  uint32_t key = 0x80000000UL | ((uint32_t)src << 16) | seq; // bit 31: never 0
  for (auto k : seen) if (k == key) return true;
  seen[seenIdx++ % 32] = key;
  return false;
}

// ---- BLE notify to every connected central (phone and/or laptop) ----
void notifyBle(const Packet &p, float rssi, float snr) {
  if (!Bluefruit.connected()) return;
  BlePacket b;
  b.pkt  = p;
  b.rssi = (int8_t)constrain((int)lroundf(rssi), -128, 127);
  b.snr4 = (int8_t)constrain((int)lroundf(snr * 4), -128, 127);
  for (uint16_t h = 0; h < BLE_MAX_CONNECTION; h++)
    if (Bluefruit.connected(h)) posChar.notify(h, &b, sizeof(b));
}

void onSosWrite(uint16_t conn, BLECharacteristic *chr, uint8_t *data, uint16_t len) {
  if (len > 0) bleSosCmd = (data[0] == 1) ? 1 : 0;   // handled in loop()
}
void onConnect(uint16_t conn) {
  // keep advertising so a second central (phone + laptop) can join
  if (Bluefruit.connected() < 2) Bluefruit.Advertising.start(0);
}

void setupBLE() {
  Bluefruit.begin(2, 0);           // up to 2 centrals: phone + laptop
  Bluefruit.setTxPower(0);
  char name[16]; snprintf(name, sizeof(name), "TrekBuddy-%d", NODE_ID);
  Bluefruit.setName(name);
  Bluefruit.Periph.setConnectCallback(onConnect);

  trekSvc.begin();
  posChar.setProperties(CHR_PROPS_NOTIFY);
  posChar.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  posChar.setFixedLen(sizeof(BlePacket));
  posChar.begin();
  sosChar.setProperties(CHR_PROPS_WRITE);
  sosChar.setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN);
  sosChar.setFixedLen(1);
  sosChar.setWriteCallback(onSosWrite);
  sosChar.begin();

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addService(trekSvc);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(160, 1600); // 100 ms fast, 1 s slow (0.625 ms units)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

// ---- Radio ----
void sendPacket(const Packet &p) {
  radio.transmit((uint8_t*)&p, sizeof(p));
  rxFlag = false;                  // TX-done also fires DIO1: ignore it
  radio.startReceive();            // back to listening
}

void sendOwn(uint8_t type, uint8_t ackTo = 0) {
  Packet p{};
  p.group = GROUP_ID; p.src = NODE_ID; p.seq = ++seqNo;
  p.type = type; p.ttl = 3;
  if (gps.location.isValid()) {
    p.lat = lround(gps.location.lat() * 1e6);
    p.lon = lround(gps.location.lng() * 1e6);
  } else p.flags |= F_NOFIX;
  p.batt = batteryPercent();
  if (p.batt < 15) p.flags |= F_LOWBAT;
  if (sosActive)   p.flags |= F_SOS;
  if (type == T_ACK) { p.lat = ackTo; p.lon = 0; }
  alreadySeen(p.src, p.seq);       // don't relay our own packet back
  sendPacket(p);
  if (type != T_ACK) notifyBle(p, 0, 0); // phone sees this pendant too
  led(LED_GREEN, true); delay(30); led(LED_GREEN, false);
}

void setSos(bool on) {
  sosActive = on; sosAcked = false; lastSos = 0;
  if (on) {
    buzz(300);                     // SOS packets start in loop()
  } else {
    buzz(100); delay(100); buzz(100);
    sendOwn(T_LOC); lastLoc = millis(); // tell everyone it is cleared
  }
}

void handlePacket(Packet &p, float rssi, float snr) {
  if (p.group != GROUP_ID || p.src == NODE_ID) return;
  if (alreadySeen(p.src, p.seq)) return;
  Serial.printf("RX src=%d type=%d lat=%.6f lon=%.6f rssi=%.1f snr=%.1f ttl=%d\n",
                p.src, p.type, p.lat / 1e6, p.lon / 1e6, rssi, snr, p.ttl);

  if (p.type != T_ACK) {           // track who has SOS active (flag on every packet)
    uint32_t bit = 1UL << (p.src & 31);
    if (p.flags & F_SOS) {
      if (!(sosNodes & bit)) lastAlert = millis() - ALERT_REPEAT_MS; // new: alert now
      sosNodes |= bit;
    } else {
      sosNodes &= ~bit;            // they cancelled: stop alerting
      silenced &= ~bit;
    }
  }
  if (p.type == T_SOS) sendOwn(T_ACK, p.src); // tell the sender we heard it
  if (p.type == T_ACK && p.lat == NODE_ID && sosActive && !sosAcked) {
    sosAcked = true;               // help is aware: stop resending, keep SOS flag
    buzz(1000);
  }
  if (p.type != T_ACK) notifyBle(p, rssi, snr);

  if (p.ttl > 0) {                 // relay (flooding mesh)
    p.ttl--;
    delay(random(50, 300));        // reduce collisions
    sendPacket(p);
  }
}

void checkButton() {
  if (digitalRead(PIN_BTN) != LOW) {
    // short press (released before 3 s) while alarmed: silence it
    if (btnDown && !btnHandled && millis() - btnDown >= 50 && (sosNodes & ~silenced)) {
      silenced |= sosNodes;
      buzz(80);
    }
    btnDown = 0; btnHandled = false; return;
  }
  if (!btnDown) btnDown = millis();
  if (!btnHandled && millis() - btnDown >= LONG_PRESS_MS) {
    btnHandled = true;             // one toggle per hold
    setSos(!sosActive);            // 3 s hold: start SOS, or cancel it
  }
}

void setup() {
  enableNfcPinsAsGpio();           // must run first (before BLE starts)
  pinMode(VBAT_ENABLE, OUTPUT); digitalWrite(VBAT_ENABLE, LOW); // keep LOW
  Serial.begin(115200);
  pinMode(PIN_BTN, INPUT_PULLUP);
  pinMode(PIN_MOTOR, OUTPUT); digitalWrite(PIN_MOTOR, LOW);
  pinMode(LED_RED, OUTPUT); pinMode(LED_GREEN, OUTPUT); pinMode(LED_BLUE, OUTPUT);
  led(LED_RED, false); led(LED_GREEN, false); led(LED_BLUE, false);
  analogReadResolution(12);
  Serial1.begin(9600);             // GPS: NEO-6M default baud

  SPI.begin();
  int st = radio.begin(865.0625, 125.0, 9, 7, 0x12, 20, 8, 1.8);
  if (st != RADIOLIB_ERR_NONE) {
    Serial.printf("LoRa init failed: %d\n", st);
    while (1) { led(LED_RED, true); delay(100); led(LED_RED, false); delay(100); }
  }
  radio.setRfSwitchPins(LORA_RXEN, RADIOLIB_NC);
  radio.setDio2AsRfSwitch(true);
  radio.setPacketReceivedAction(onDio1);
  radio.startReceive();

  setupBLE();
  randomSeed(NRF_FICR->DEVICEID[0]); // unique per chip
  buzz(150);                       // boot OK
}

void loop() {
  while (Serial1.available()) gps.encode(Serial1.read());

  checkButton();
  if (bleSosCmd >= 0) { bool on = bleSosCmd == 1; bleSosCmd = -1; setSos(on); }

  if (sosActive && !sosAcked && millis() - lastSos >= SOS_RETRY_MS) {
    sendOwn(T_SOS); lastSos = millis();
  }
  if (millis() - lastLoc >= LOC_INTERVAL_MS) {
    sendOwn(T_LOC); lastLoc = millis();
  }

  // someone else's SOS: buzz 3 times every 8 s until they cancel or we silence it
  bool alerting = (sosNodes & ~silenced) != 0;
  if (alerting && millis() - lastAlert >= ALERT_REPEAT_MS) {
    lastAlert = millis();
    for (int i = 0; i < 3; i++) { buzz(400); delay(200); }
  }

  if (rxFlag) {
    rxFlag = false;
    Packet p;
    bool ok = radio.getPacketLength() == sizeof(Packet) &&
              radio.readData((uint8_t*)&p, sizeof(p)) == RADIOLIB_ERR_NONE;
    float rssi = radio.getRSSI(), snr = radio.getSNR();
    radio.startReceive();
    if (ok) handlePacket(p, rssi, snr);
  }

  // red: blinking = SOS sent, solid = SOS acknowledged
  // green: blinking = someone else's SOS is active; blue: BLE connected
  led(LED_RED, sosActive && (sosAcked || (millis() / 250) % 2));
  led(LED_GREEN, (sosNodes & ~silenced) && (millis() / 250) % 2);
  led(LED_BLUE, Bluefruit.connected() > 0);
  delay(10);                       // lets FreeRTOS sleep the CPU between loops
}

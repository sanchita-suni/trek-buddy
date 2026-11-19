"""Trek Buddy pendant case v2 (CadQuery, parametric), built around Sally's measured layout.

Axes: X = length (x=0 is the inside face of the MOTOR end wall), Y = width (centred),
Z = height (z=0 is the outside of the floor). The lid closes the top (+Z).
Parts: shell (open top), lid (snap clips + optional M2 screws), button caps, USB plug.
Print: shell open side up, lid outer face down, caps flange down, USB plug flange down. No supports.
"""
import cadquery as cq

# ---------------- measured parts (mm) ----------------
STRIP_W   = 22.0    # (3) perfboard strip width
GPS_W     = 28.0    # (1) GPS module width
RUN_L     = 110.0   # (2) strip + GPS overall length
MOTOR_D   = 10.0    # (4) coin motor diameter
STACK_H   = 40.0    # (5) seeed stack height above the bottom of the strip
BTN_H     = 42.0    # (6) top of the push button above the bottom of the strip
STACK_X   = 50.0    # centre of the seeed stack / button, measured from the motor end of the strip

# ---------------- assumptions to confirm ----------------
USB_SIDE  = "motor_end"  # USB-C points toward the motor end wall
USB_Z     = 36.0    # height of the USB-C port centre above the bottom of the strip
USB_W, USB_H = 13.0, 12.0     # opening for the plug body (tall to allow for height error)
ANT_HOLE  = 5.0     # LoRa antenna hole in the +Y long wall, level with the stack
ANT_Z     = 30.0    # antenna hole centre above the bottom of the strip

# ---------------- case parameters ----------------
WALL, FLOOR, LID = 2.0, 2.0, 2.0
RAIL_H    = 2.0     # standoff rails so solder joints under the strip clear the floor
CLEAR     = 1.0
MOTOR_ZONE = 13.0   # motor end, before the strip starts
SCREW_ZONE = 7.0    # GPS end, room for the screw boss
BTN_HOLE  = 8.0     # square opening for the button (8 x 8 as asked)
CAP_FLANGE, CAP_STEM = 1.0, 1.5   # nominal; extra caps are exported with other stem lengths
FIT       = 0.2

IN_L = MOTOR_ZONE + RUN_L + CLEAR + SCREW_ZONE
IN_W = GPS_W + 2 * CLEAR
BTN_Z = FLOOR + RAIL_H + BTN_H                   # top of button (absolute)
IN_H = RAIL_H + BTN_H + CAP_STEM + CAP_FLANGE     # floor top to lid underside
OL, OW = IN_L + 2 * WALL, IN_W + 2 * WALL
SHELL_H = FLOOR + IN_H
TOP = SHELL_H                                     # lid underside
X0 = -IN_L / 2                                    # world x of the inside of the motor end wall
def X(x): return X0 + x                           # interior coords -> world
STRIP_X0 = MOTOR_ZONE
BTN_X = STRIP_X0 + STACK_X

def rbox(l, w, h, r):
    return cq.Workplane("XY").rect(l, w).extrude(h).edges("|Z").fillet(r)

# ---------------- shell ----------------
shell = rbox(OL, OW, SHELL_H, 5.0).faces("<Z").edges().fillet(1.5)
shell = shell.cut(rbox(IN_L, IN_W, SHELL_H, 3.0).translate((0, 0, FLOOR)))
inside = rbox(IN_L, IN_W, SHELL_H, 3.0)

# standoff rails under the strip and GPS
for y in (-9.5, 9.5):
    rail = cq.Workplane("XY").center(X(STRIP_X0 + RUN_L / 2), y).rect(RUN_L, 2.0).extrude(RAIL_H).translate((0, 0, FLOOR))
    shell = shell.union(rail)

# coin-motor holder ring (motor sticks to the floor inside it, so the buzz goes into the case)
MX, MY = 7.0, -6.0
ring = (cq.Workplane("XY").center(X(MX), MY).circle(MOTOR_D / 2 + 0.4 + 1.2).circle(MOTOR_D / 2 + 0.4)
        .extrude(2.0).translate((0, 0, FLOOR)))
shell = shell.union(ring)

# screw bosses (M2 self-tapping, optional)
#  motor end: full-height corner boss
#  GPS end: short corner boss hanging off the walls (45 deg cone under it, prints without supports),
#           so the end wall below it is free for the GPS antenna
BOSSES = [(2.7, 11.3), (IN_L - 2.7, 11.3)]
BOSS_R = 3.2
bx, by = BOSSES[0]
boss = cq.Workplane("XY").center(X(bx), by).circle(BOSS_R).extrude(SHELL_H - FLOOR).translate((0, 0, FLOOR))
shell = shell.union(boss.intersect(inside))
bx, by = BOSSES[1]
SB = 12.0                                                    # short boss length
top_boss = cq.Workplane("XY").center(X(bx), by).circle(BOSS_R).extrude(SB).translate((0, 0, TOP - SB))
cone = cq.Solid.makeCone(0.01, BOSS_R, BOSS_R, pnt=cq.Vector(X(bx), by, TOP - SB - BOSS_R))
shell = shell.union(top_boss.union(cq.Workplane().add(cone)).intersect(inside))
for bx, by in BOSSES:
    shell = shell.cut(cq.Workplane("XY").center(X(bx), by).circle(0.85).extrude(11).translate((0, 0, TOP - 11)))

# GPS antenna pad on the inside of the GPS end wall (the top when worn):
# a U-shaped rib frame that locates a 25 x 25 mm patch; stick the patch in it, ceramic face toward the wall
ANT_PATCH = 25.0
ANT_ZC = FLOOR + 18.0
fx = X(IN_L) - 0.75                                          # ribs stand 1.5 mm off the end wall
for y0, z0, w, h in [(-(ANT_PATCH / 2 + 0.9), ANT_ZC, 1.2, ANT_PATCH + 2.4),   # side rib
                     ((ANT_PATCH / 2 + 0.9), ANT_ZC, 1.2, ANT_PATCH + 2.4),    # side rib
                     (0, ANT_ZC - ANT_PATCH / 2 - 0.6, ANT_PATCH + 3.0, 1.2)]: # bottom rib (top left open for the cable)
    rib = cq.Workplane("YZ").center(y0, z0).rect(w, h).extrude(1.5).translate((fx - 0.75, 0, 0))
    shell = shell.union(rib)

# snap-clip recesses in the long walls
CLIP_XS = [32.0, 100.0]
TAB_L, TAB_T, TAB_W, HOOK = 7.0, 1.4, 10.0, 0.8
ZB = TOP - TAB_L                                   # bottom of a lid tab
for cx in CLIP_XS:
    for s in (-1, 1):
        rec = (cq.Workplane("XY").center(X(cx), s * (IN_W / 2 + 0.5)).rect(TAB_W + 2, 1.0)
               .extrude(1.6 + 0.35 + 0.3).translate((0, 0, ZB - 0.3)))
        shell = shell.cut(rec)

# USB-C opening
usb_zc = FLOOR + RAIL_H + USB_Z                   # opening in the motor end wall, in line with the port
shell = shell.cut(cq.Workplane("YZ").center(0, usb_zc).rect(USB_W, USB_H).extrude(WALL * 4, both=True)
                  .translate((-OL / 2, 0, 0)))

if ANT_HOLE:
    shell = shell.cut(cq.Workplane("XZ").center(X(BTN_X), FLOOR + RAIL_H + ANT_Z).circle(ANT_HOLE / 2)
                      .extrude(WALL * 4, both=True).translate((0, OW / 2, 0)))

# lanyard tab on the GPS end, flush with the floor
tab = cq.Workplane("XY").center(OL / 2 + 4, 0).rect(16, 16).extrude(5.0).edges("|Z").fillet(7.9)
tab = tab.cut(cq.Workplane("XY").center(OL / 2 + 6, 0).circle(2.5).extrude(10))
shell = shell.union(tab)

# ---------------- lid ----------------
lid = rbox(OL, OW, LID, 5.0).faces(">Z").edges().fillet(1.0).translate((0, 0, TOP))
for cx in CLIP_XS:
    for s in (-1, 1):
        yo = s * (IN_W / 2 - FIT)                  # outer face of the tab
        tabb = (cq.Workplane("XY").center(X(cx), yo - s * TAB_T / 2).rect(TAB_W, TAB_T)
                .extrude(TAB_L).translate((0, 0, ZB)))
        # hook: ramp at the bottom, flat catch on top
        pts = [(yo, ZB), (yo + s * HOOK, ZB + 1.0), (yo + s * HOOK, ZB + 1.6), (yo, ZB + 1.6)]
        hook = (cq.Workplane("YZ").polyline(pts).close().extrude(TAB_W / 2, both=True).translate((X(cx), 0, 0)))
        lid = lid.union(tabb).union(hook)
# button opening (8 x 8)
lid = lid.cut(cq.Workplane("XY").center(X(BTN_X), 0).rect(BTN_HOLE, BTN_HOLE).extrude(LID * 3).translate((0, 0, TOP - 1)))
# shallow square dish around it so it is easy to find by touch
lid = lid.cut(cq.Workplane("XY").center(X(BTN_X), 0).rect(BTN_HOLE + 6, BTN_HOLE + 6).extrude(0.8).translate((0, 0, TOP + LID - 0.8)))
# screw clearance + counterbore
for bx, by in BOSSES:
    lid = lid.cut(cq.Workplane("XY").center(X(bx), by).circle(1.15).extrude(LID * 3).translate((0, 0, TOP - 1)))
    lid = lid.cut(cq.Workplane("XY").center(X(bx), by).circle(2.1).extrude(1.2).translate((0, 0, TOP + LID - 1.2)))
# optional antenna hole uses ANT_HOLE (above)

# ---------------- button cap (square, flange under the lid) ----------------
def cap(stem):
    s = BTN_HOLE - 0.4
    flange = cq.Workplane("XY").rect(BTN_HOLE + 3, BTN_HOLE + 3).extrude(CAP_FLANGE).edges("|Z").fillet(1.0)
    shaft = cq.Workplane("XY").rect(s, s).extrude(LID + 1.0).edges("|Z").fillet(1.0).translate((0, 0, CAP_FLANGE))
    st = cq.Workplane("XY").circle(1.6).extrude(-stem)
    return flange.union(shaft).union(st)

# ---------------- USB plug (closes the opening once the battery is in) ----------------
usb_plug = (cq.Workplane("XY").rect(USB_W + 4, USB_H + 4).extrude(1.2).edges("|Z").fillet(1.5)
            .union(cq.Workplane("XY").rect(USB_W - 0.3, USB_H - 0.3).extrude(WALL).translate((0, 0, 1.2)))
            .union(cq.Workplane("XY").center(0, (USB_H + 4) / 2 + 2).rect(5, 5).extrude(1.2)))  # pull tab

if __name__ == "__main__":
    import os
    out = os.path.dirname(os.path.abspath(__file__))
    ex = lambda p, n: cq.exporters.export(p, os.path.join(out, n), tolerance=0.02, angularTolerance=0.1)
    ex(shell, "trek_v2_shell.stl"); ex(lid, "trek_v2_lid.stl"); ex(usb_plug, "trek_v2_usb_plug.stl")
    for stem in (1.0, 1.5, 2.5):
        ex(cap(stem), f"trek_v2_button_cap_stem{str(stem).replace('.', '_')}.stl")
    asm = (cq.Assembly().add(shell, name="shell", color=cq.Color(0.85, 0.85, 0.88))
           .add(lid, name="lid", color=cq.Color(0.95, 0.55, 0.2))
           .add(cap(CAP_STEM).translate((X(BTN_X), 0, TOP - CAP_FLANGE)), name="cap", color=cq.Color(0.8, 0.1, 0.1)))
    asm.save(os.path.join(out, "trek_v2.step"))
    print(f"Outer: {OL:.1f} x {OW:.1f} x {SHELL_H + LID:.1f} mm (+ lanyard tab)")
    print(f"Inside: {IN_L:.1f} x {IN_W:.1f} x {IN_H:.1f} mm")
    print(f"Button centre: {BTN_X:.1f} mm from motor-end inner wall; USB centre {usb_zc:.1f} mm above outside floor")

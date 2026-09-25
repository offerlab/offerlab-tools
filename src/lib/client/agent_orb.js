// Mirrored from the main app (app/javascript/lib/agent_orb.js) verbatim; tune it there and copy it back.
// The agent orb: a WebGL fragment shader that renders OfferLab's AI identity.
//
// WHY A SHADER. This started as layered CSS radial gradients and had to be thrown away. The
// reference tool's own controls are the tell — blob size, motion, colour ripple, curvature, edge
// softness — every one of those operates per-pixel on a noise field, and CSS has no per-pixel stage
// to hook. Gradients give you hard geometric lobes; a fluid mesh needs FBM noise sampled per
// fragment. Canvas2D could sample it but would need per-pixel JS and won't hold 60fps.
//
// SEAMLESS BY CONSTRUCTION. The loop isn't eased or cross-faded — noise is sampled along a CIRCLE in
// noise space, so t and t+loop land on the identical sample and the animation closes exactly. That's
// why `loopDuration` is a real parameter rather than an approximation.
//
// One module, two callers: the Stimulus controller and the tuning playground. The shader lives here
// once so the thing you tune is the thing that ships.

export const ORB_DEFAULTS = {
  // Dialled in by hand in the playground, not derived. Two notes on the pair:
  //
  // colorA is a LIGHTER moola (#397a29) rather than --bg-fill-moola (#254f1a). The brand green is
  // tuned for text and fills, and against shine yellow inside a sphere it was so dark that the mix
  // read as yellow-on-black with no green identity in it. Lifting it lets both colours register.
  // Intentionally a literal, not the token — this is a lighting decision about this surface, and
  // silently diverging from the token would be worse than diverging from it on purpose.
  //
  // motion 0.35 is a slow drift. The orb is ambient at rest; the pace states below are what make it
  // urgent when there's a reason to be.
  colorA: "#397a29",
  colorB: "#ffed84",
  loopDuration: 5,
  blobSize: 4,
  motion: 0.35,
  colorBalance: 0,
  paletteShift: 0,
  colorRipple: 2,
  rimLight: 0.25,
  specular: 0.44,
  shading: 0.07,
  curvature: 0.8,
  lightX: -1,
  lightY: 1,
  edgeSoftness: 0.005,
  glow: 1.5,
  // How much a diagonal SPATIAL gradient contributes to the colour mix, on top of the noise.
  //
  // Default 0, and that is deliberate. It was added to stop large blob sizes collapsing to one
  // colour, which it does — but "collapsing" turned out to be the look that was actually wanted: at
  // blobSize 4 with no sweep the field flattens into a soft, diffuse, nearly single-tone sphere, and
  // that is what got dialled in and approved. Forcing the sweep on rewrote an approved look under the
  // guise of fixing it. So it stays available for when two distinct colours are the goal, and off by
  // default so the tuned values render as tuned.
  colorSweep: 0,
  // Ink for the DOTTED forms, and deliberately NOT the green/yellow pair above.
  //
  // The smooth mesh is our AI identity and is meant to be colourful. The dotted forms are loaders, and
  // they live on LIGHT chips — the crawling chip on the website step being the case in point. Tinting
  // them green-and-yellow was a straight port bug: thinking-orbs draws them as dark ink on light
  // surfaces (its `dark: false` mode), and colour there fights the surface instead of reading on it.
  // Chocolate (--content-primary) is what every other mark on those chips uses. Overridable, so a
  // dotted form on a dark surface can be given light ink instead.
  dotColor: "#342e26",
  // WHICH FORM. One axis, three names — see FORMS. Changing this at runtime MORPHS rather than
  // cuts (see morphTo).
  form: "mesh",
  // How long a form change takes, ms.
  morphMs: 600,
  // How long a PACE change takes, ms — the orb easing from one state's loop length to another's.
  // Non-zero by default because a state change is a statement about what the agent is doing, and
  // those transitions are always something the eye should be able to follow rather than catch.
  paceMs: 700
}

// The three forms, and the only names any caller should use. Numbers are an implementation detail of
// the shader's blend and deliberately not part of the API — `form: "bands"` says what you get,
// `form: 2` says nothing.
//
// Naming is about SHAPE, not activity, because `state` already owns activity vocabulary. A form
// called "thinking" sitting next to `state: "thinking"` would mean two unrelated things, which is
// precisely the ambiguity that made this component hard to talk about.
export const FORMS = {
  // The smooth shaded sphere. OfferLab's own, and the only one that wears colorA/colorB.
  mesh: 0,
  // thinking-orbs' 'searching': dotted lat/lon sphere with a scan meridian sweeping it. Flat ink.
  globe: 1,
  // thinking-orbs' 'composing' — the one its site labels "Thinking...". An undulating multi-band
  // sash of meridian dashes. Flat ink.
  bands: 2
}

function formIndex(form) {
  if (typeof form === "number") return form
  return FORMS[form] ?? FORMS.mesh
}

// ── WHICH FORMS WE KEEP ──────────────────────────────────────────────────────────────────────────
// TWO. Read from thinking-orbs@0.1.1's own source, whose modes map:
//
//   searching → globe   (17-ring lat/lon dot sphere)                    KEPT — form 0
//   solving   → rubik   (lat/lon sphere with slabs twisting)            KEPT — form 1
//   working   → orbits  (12 great circles, travelling particles)        REMOVED
//
// There is no `thinking` mode in that library — the word appears nowhere in it, despite the package
// name. An earlier note here claimed `thinking → orbits`, which was simply wrong and sent every agent
// chip in the app to the library's WORKING visual: the one thing we deliberately replaced with our
// own green-and-yellow orb. Orbits is therefore gone rather than merely unused, along with its ~88
// lines of ellipse-inversion shader.
//
// `globe` is the form the product actually wants wherever an agent is thinking. The PACE is a
// separate axis — see ORB_STATES — so "thinking" is state, not shape.
//
// Also dropped: wave, ribbon, morph — nothing needs them, and every kept mode is shader code we own.
//
// A NOTE FOR THE NEXT PORT, because globe's technique does not transfer. Globe inverts cheaply: the
// dots sit on a lat/lon grid, so from a fragment you recover the sphere point and snap to the nearest
// grid cell in O(1). Orbits has no grid — its 12 rings are arbitrarily oriented great circles, ~516
// dots in total, so neither brute force (516 distance checks per fragment) nor grid-snapping works.
// The technique it needs is DISTANCE TO EACH RING: for each of the 12 circles find the nearest point
// on it to the fragment, snap that parameter to the nearest of the 40 ghost positions, and test only
// that dot plus the 3 particles. ~48 checks per fragment, which is affordable.
//
// RUBIK — this corrects an earlier note saying it "reuses globe's inversion once the slab is known".
// That framing hid a chicken-and-egg problem: rubik applies up to 14 conditional 90-degree rotations,
// each only to points inside a coordinate slab, so which rotations a point received depends on its own
// PRE-rotation coordinates, which is exactly what inverting is trying to recover. Taken at face value
// that is a 2^14 branch space and rubik is the HARDEST of the three, not the easiest.
//
// It collapses on one observation: each move rotates ABOUT the same axis its slab test reads, and a
// rotation about an axis leaves that axis's coordinate untouched. So the slab test gives the identical
// answer before and after its own rotation, and inversion is just undoing the moves in reverse order,
// testing each slab on the coordinates you currently hold. No branching, no guessing.
//
// The port is therefore: globe's inversion, undo the move list, globe's grid snap. Pieces needed from
// the library: F(e,n) = fract(sin(e*12.9898 + n*78.233) * 43758.5453) for the deterministic move list,
// at(n) to build it (axis, slab bounds, +/-90), and et(t, n, 0.42, 1.2) for the per-move envelope —
// 2*n*0.42s of moves then 1.2s rest, eased 1-(1-min(1, m/0.7))^3, unwinding on the back half. This
// mode's constants: 15 rings, lonDensity 40, moveCount 14, yaw t*0.55, tilt 0.35 + 0.1*sin(t*0.9),
// rActive +0.3, active dots 0.14 darker.

// NAMED STATES — the versatility layer. The orb has one look and several PACES, and which pace it
// runs at is a statement about what the agent is doing. Deliberately the same vocabulary as the
// thinking-orbs presets already used elsewhere in the app (searching / working / solving), so the two
// orb families can be swapped or cross-faded on a surface without the states being renamed.
//
// Only motion-related parameters live here. State changes how the orb MOVES, never how it looks —
// otherwise "working" would read as a different orb rather than the same one working.
// The ladder is calibrated to the product's calmest approved motion (working = 0.18 over a 9s
// loop), and each step is roughly double the last, which is what reads as a gear change rather
// than a nudge.
export const ORB_STATES = {
  // A CLOUD, NOT A PULSE. Never stops, never hurries.
  //
  // The same `motion` as `working` — deliberately identical, because the movement itself is right and
  // this is not a different kind of movement. What changes is `loopDuration`: `motion` is the RADIUS
  // of the circle the noise is sampled along and `loopDuration` is how long one circuit takes, so a
  // 5x longer loop is the identical path through the identical noise, walked at a crawl.
  //
  // THIS REPLACED A DUTY CYCLE that stirred for a second and then held perfectly still for three to
  // five, and stopping was exactly what was wrong with it. Something that halts and restarts reads as
  // a timer firing — the eye catches the transition every time, and a start is an event whether or
  // not it was eased. Continuous-but-barely is the opposite: there is no moment to catch, so nothing
  // announces itself, and glancing back after a few seconds finds the orb somewhere slightly else.
  //
  // `drift` is what keeps that from being mechanical. A constant slow rate is still a metronome, just
  // a quiet one. This wanders the rate between 0.4x and 1x on two periods that don't divide into each
  // other, so the combination never visibly repeats — and the floor is 0.4, not 0, because the whole
  // point is that it never arrives at a stop.
  idle: {
    motion: 0.18,
    loopDuration: 42,
    drift: { min: 0.4, max: 1, periodA: 13, periodB: 19 }
  },
  // Reading something. FASTER **AND** LIVELIER than idle — above it on both loop speed and
  // amplitude, because a state that cycles quicker while deforming less is illegible on a 20px
  // mark.
  thinking: { motion: 0.22, loopDuration: 9 },
  // Doing something with what it read. The commissions chip's approved pace.
  working: { motion: 0.18, loopDuration: 9 },
  // Committing a change. Should never run more than a beat or two.
  acting: { motion: 0.35, loopDuration: 5 },
  // Frozen but visible — the "our AI made this" watermark, not the same as hiding it. Distinct from
  // `idle`: this one never moves at all. The loop is still running; there is simply nothing to move.
  // To stop the loop instead, that is handle.freeze(t).
  still: { motion: 0 }
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

// Simplex-ish value noise + FBM. Hand-rolled rather than pulled from a library: this needs to be one
// self-contained string with no build step, and three octaves is plenty at orb scale.
const FRAG = `
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform float uLoopDuration;
uniform float uPhase;
uniform float uBlobSize;
uniform float uMotion;
uniform float uColorBalance;
uniform float uPaletteShift;
uniform float uColorRipple;
uniform float uRimLight;
uniform float uSpecular;
uniform float uShading;
uniform float uCurvature;
uniform vec2  uLight;
uniform float uEdgeSoftness;
uniform float uGlow;
uniform float uColorSweep;
// THE FORM AXIS. One axis, three values (0 mesh · 1 globe · 2 bands), and morphing is expressed
// as being part-way BETWEEN two of them rather than as a second parameter. uFormT walks 0→1 while
// uFormFrom holds what we left and uFormTo what we are arriving at; at rest the two are equal and
// t is irrelevant. That is what lets any form reach any other.
uniform float uFormFrom;
uniform float uFormTo;
uniform float uFormT;
uniform vec3 uDotColor;
uniform float uSize;   // rendered CSS px, so the dot designs can resolve per size

vec2 hash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise(vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  float m = step(a.y, a.x);
  vec2 o = vec2(m, 1.0 - m);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hash(i)), dot(b, hash(i + o)), dot(c, hash(i + 1.0)));
  return dot(n, vec3(70.0));
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  // TWO octaves, not three. Three read as marbled veining rather than the reference's few large
  // lobes — at 36px the third octave is sub-pixel noise that only muddies the colour mix.
  for (int i = 0; i < 2; i++) {
    v += amp * noise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return v;
}

// ── THE GLOBE, PORTED ────────────────────────────────────────────────────────────────────────────
// thinking-orbs' 'globe' mode (what its 'searching' state renders), transcribed rather than
// approximated. The library draws it with one arc() in a lat/lon loop — 17 rings, up to 44 dots per
// ring — so the design is entirely "where are the dots, how big, how bright", which is pure trig and
// ports exactly.
//
// INVERTED, not looped. Painting it the library's way would mean ~470 distance checks per fragment.
// Instead the projection is run BACKWARDS: from the fragment, recover the sphere point beneath it,
// convert to lat/lon, and check only the nine grid cells that could own this pixel. Same math, O(1).
//
// Constants are the library's own defaults for this mode and are the design, not knobs:
//   R 0.82 · latRings 17 · lonDensity 44 · rBase 0.6 · rDepth 1.7 · inkFar 0.62 · inkSpan 0.54
//   tilt 0.4 + 0.06·sin(t·0.35) · yaw t·0.5 · scan falloff exp(-S²/0.18)
// SIZE RESPONSIVENESS IS MISSING, and this is a real fidelity bug, not a polish item. The library
// resolves three per-size multipliers (its St table) and our port ignores all of them, which is why
// a small orb reads as a solid speckled mass instead of a legible few dots:
//
//              count    size    speed    extra
//   globe 64:  0.42     1.15    2.015    scanMul 4.08,  dimBase 0.45
//   globe 20:  0.105    1.75    2.665    scanMul 4.335, dimBase 0.45
//   rubik 64:  0.35     1.05    1.82
//   rubik 20:  0.088    1.90    1.95
//
// 'count' does NOT scale dot counts directly — kt() applies sqrt(count) to the rings/density PAIR,
// floored at 2. So globe at 64 is round(17*sqrt(0.42)) = 11 rings and round(44*0.648) = 29 lon, and at
// 20 it is 6 rings and 14 lon. Fewer dots as it shrinks, which is the whole point. 'size' multiplies
// dot radius the other way (1.15 → 1.75), so they also get chunkier. Three separate mechanisms.
//
// Two more misses in this port: scanMul is hardcoded 1 below where the real value is ~4, so the scan
// meridian sweeps four times too slowly; and dimBase 0.45 is not implemented at all, so un-scanned
// dots are fully opaque instead of held at 45% — that fade is what makes the meridian read.
//
// Fixing it means passing the rendered pixel size into the shader as a uniform and interpolating
// these between the 20 and 64 anchors the way resolvePreset() does.
const float G_R = 0.82;
// Base counts, before the per-size 'count' factor. Never used raw — see gCount() below.
const float G_RINGS = 17.0;
const float G_LON = 44.0;

// The library tunes exactly two designs, 20px (inline) and 64px (avatar), and interpolates between
// them. Outside that span it clamps rather than extrapolating, which matters: extrapolating 'count'
// up to a 220px orb would multiply the dots into mush, and down to 12px would floor them out entirely.
// The library floors every dot at rMin 0.3 PX before painting (its _() painter: max(rMin, r)). Ours
// works in uv where 1.0 is the orb's half-size, so the floor has to be converted per size — and it is
// exactly what was missing from the ghost rings: at 220px a 0.9*m ghost is well under a pixel, so
// without the floor it renders as a hairline that all but disappears.
float rMinUv() {
  return 0.3 / max(uSize * 0.5, 1.0);
}

float presetT() {
  return clamp((uSize - 20.0) / 44.0, 0.0, 1.0);
}

// count does NOT scale the counts directly. kt() takes sqrt and applies it to the rings/density PAIR,
// floored at 2 — that sqrt is why a 3x drop in 'count' is only a ~1.7x drop in each dimension.
vec2 gridFor(float baseRings, float baseLon, float count) {
  float k = sqrt(count);
  return vec2(max(2.0, floor(baseRings * k + 0.5)), max(2.0, floor(baseLon * k + 0.5)));
}

// Forward projection, matching the library's q(): yaw about the vertical, then tilt.
vec3 gProject(vec3 pLocal, float sinY, float cosY, float sinT, float cosT) {
  float u = pLocal.x * cosY + pLocal.z * sinY;
  float h = -pLocal.x * sinY + pLocal.z * cosY;
  float b = pLocal.y * cosT - h * sinT;
  float d = pLocal.y * sinT + h * cosT;   // depth, the library's third return value
  return vec3(u, b, d);
}

// Shortest signed angular distance — the library's ot().
float gAngDist(float a, float b) {
  return atan(sin(a - b), cos(a - b));
}

// ── BANDS ─────────────────────────────────────────────────────────────────
// thinking-orbs calls this 'composing'; its site labels it "Thinking...", which is the one the
// product wants. Their README describes it as "an undulating multi-band sash".
//
// AN INTERPRETATION, NOT A PORT, and that distinction is deliberate. Their shader source is not
// published (the npm package ships built output and the repo README documents states, not maths), so
// unlike globe and rubik this was not transcribed. It is rebuilt from the rendered thing: dots run in
// MERIDIAN columns rather than on an even lat/lon grid, which is what makes them read as vertical
// dashes; those columns are gated by a sash whose centre latitude undulates as it travels around the
// sphere, so the band rises and falls instead of sitting as a flat ring; and a second, fainter sash
// trails it, which is the "multi-band" part.
//
// Shares globe's machinery wholesale — same inversion, same grid snap, same per-hemisphere pass —
// because the geometry underneath is the same sphere. Only the density and the gating differ.
const float B_RINGS = 30.0;
const float B_LON = 26.0;

float bandsDots(vec2 nuv, float tRaw, float radiusMul, out float shade) {
  float pt = presetT();
  // Far more latitude rows than longitude columns: that ratio IS the vertical-dash look. Dropping the
  // column count at small sizes keeps the dashes from merging into a solid skin.
  vec2 grid = gridFor(B_RINGS, B_LON, mix(0.34, 0.95, pt));
  float rings = grid.x, lonD = grid.y;
  float sizeMul = mix(0.72, 1.0, pt);
  float t = tRaw * mix(2.3, 1.8, pt);

  float tilt = 0.42 + 0.05 * sin(t * 0.4);
  float yaw = t * 0.42;
  float sinT = sin(tilt), cosT = cos(tilt);
  float sinY = sin(yaw), cosY = cos(yaw);

  float q2 = dot(nuv, nuv);
  shade = 0.0;
  if (q2 > 1.0) return 0.0;

  float cover = 0.0;
  float bestDepth = -2.0;

  for (int hemiI = 0; hemiI < 2; hemiI++) {
    float hemi = hemiI == 0 ? 1.0 : -1.0;
    float depth = hemi * sqrt(max(1.0 - q2, 0.0));

    float u = nuv.x, b = -nuv.y;
    float y = b * cosT + depth * sinT;
    float h = -b * sinT + depth * cosT;
    float x = u * cosY - h * sinY;
    float z = u * sinY + h * cosY;

    float lat = asin(clamp(y, -1.0, 1.0));
    float lon = atan(z, x);
    float ringF = (lat + 1.5707963) / 3.14159265 * rings;

    for (int dr = -1; dr <= 1; dr++) {
      float P = clamp(floor(ringF + 0.5) + float(dr), 0.0, rings);
      float rlat = -1.5707963 + P / rings * 3.14159265;
      float cosLat = cos(rlat), sinLat = sin(rlat);
      float k = max(1.0, floor(abs(cosLat) * lonD + 0.5));
      float colF = lon / 6.28318531 * k;

      for (int dc = -1; dc <= 1; dc++) {
        float v = floor(colF + 0.5) + float(dc);
        float rlon = v / k * 6.28318531;
        vec3 proj = gProject(vec3(cosLat * cos(rlon), sinLat, cosLat * sin(rlon)), sinY, cosY, sinT, cosT);
        if (proj.z * hemi < 0.0) continue;

        // THE SASH. Its centre latitude rides a wave around the sphere, so the band lifts and dips as
        // it wraps rather than reading as a level ring. The second sash sits below and behind it.
        float phase = rlon + t * 0.9;
        float c1 = 0.30 * sin(phase);
        float c2 = -0.42 + 0.20 * sin(phase * 2.0 + 1.7);
        float s1 = 1.0 - smoothstep(0.16, 0.62, abs(sinLat - c1));
        float s2 = 1.0 - smoothstep(0.10, 0.40, abs(sinLat - c2));
        float band = max(s1, s2 * 0.8);
        if (band <= 0.001) continue;

        float f = (proj.z + 1.0) / 2.0;
        // The dash: taller than it is wide, which a round dot cannot express — so the distance test is
        // scaled, squashing the circle into a stroke that runs along the meridian.
        float rad = max(rMinUv(), (0.5 + 1.5 * f) * sizeMul / max(uSize * 0.5, 1.0)) * radiusMul;
        vec2 d = nuv - vec2(proj.x, -proj.y);
        d.x /= 0.42;   // narrow across the column, full length along it
        float dotA = (1.0 - smoothstep(rad * 0.7, rad, length(d))) * band;

        if (dotA > 0.0 && proj.z > bestDepth) {
          bestDepth = proj.z;
          // Same ink rule as globe: faint at rest, the band's own crest carrying it toward solid.
          shade = mix(0.88, 0.46, f) - band * 0.30;
        }
        cover = max(cover, dotA);
      }
    }
  }
  return cover;
}


float globeDots(vec2 nuv, float tRaw, float radiusMul, out float shade) {
  float pt = presetT();
  // globe: count .105→.42, size 1.75→1.15, speed 2.665→2.015, scanMul 4.335→4.08, dimBase .45
  vec2 grid = gridFor(G_RINGS, G_LON, mix(0.105, 0.42, pt));
  float rings = grid.x, lonD = grid.y;
  // DOT SIZE BY PLACEMENT, and we deliberately go the OTHER WAY to the library here. Its own preset
  // is mix(1.75, 1.15) — fatter dots at 20px than at 64px — which is right for its dark ground, where
  // a thin light dot on black needs bulk to register. On our light chips the ink is dark and reads at
  // far less weight, so the same bulk makes a 24px orb chunky: applying the library's factor straight
  // produced a solid blob. Scaled DOWN at small sizes instead, holding the 64px design as tuned.
  float sizeMul = mix(0.72, 1.0, pt);
  float t = tRaw * mix(2.665, 2.015, pt);
  float scanMul = mix(4.335, 4.08, pt);
  const float dimBase = 0.45;

  float tilt = 0.4 + 0.06 * sin(t * 0.35);
  float yaw = t * 0.5;
  float sinT = sin(tilt), cosT = cos(tilt);
  float sinY = sin(yaw), cosY = cos(yaw);
  float scanT = t * (0.5 + 1.2 * scanMul);   // the library's 0.5 + (1.7-0.5)*scanMul

  float q2 = dot(nuv, nuv);
  shade = 0.0;
  if (q2 > 1.0) return 0.0;

  float cover = 0.0;
  float bestDepth = -2.0;

  for (int hemiI = 0; hemiI < 2; hemiI++) {
    float hemi = hemiI == 0 ? 1.0 : -1.0;
    float depth = hemi * sqrt(max(1.0 - q2, 0.0));

    // Inverse of gProject: recover the sphere point under this fragment.
    float u = nuv.x, b = -nuv.y;
    float y = b * cosT + depth * sinT;
    float h = -b * sinT + depth * cosT;
    float x = u * cosY - h * sinY;
    float z = u * sinY + h * cosY;

    float lat = asin(clamp(y, -1.0, 1.0));
    float lon = atan(z, x);

    float ringF = (lat + 1.5707963) / 3.14159265 * rings;

    // Nine candidates: the nearest ring and its neighbours, and within each the nearest column.
    for (int dr = -1; dr <= 1; dr++) {
      float P = clamp(floor(ringF + 0.5) + float(dr), 0.0, rings);
      float rlat = -1.5707963 + P / rings * 3.14159265;
      float cosLat = cos(rlat), sinLat = sin(rlat);
      float k = max(1.0, floor(abs(cosLat) * lonD + 0.5));
      float colF = lon / 6.28318531 * k;

      for (int dc = -1; dc <= 1; dc++) {
        float v = floor(colF + 0.5) + float(dc);
        float rlon = v / k * 6.28318531;
        vec3 proj = gProject(vec3(cosLat * cos(rlon), sinLat, cosLat * sin(rlon)), sinY, cosY, sinT, cosT);

        // Only the hemisphere we're currently solving for owns this fragment.
        if (proj.z * hemi < 0.0) continue;

        float f = (proj.z + 1.0) / 2.0;
        float S = gAngDist(rlon + yaw, scanT);
        float L = exp(-(S * S) / 0.18) * max(0.0, proj.z);
        // THREE THINGS WERE WRONG HERE, and all three shrank the dots — which is why the globe
        // faded out at the small inline placements while reading fine at avatar size.
        //
        // 1. The divisor was 64, the library's reference DIAMETER. uv 1.0 is the orb's HALF-size
        //    (see rMinUv), so a px radius converts against the radius — 32 at that reference. Every
        //    dot was drawn at exactly half the size the library draws it.
        // 2. sizeMul was computed above and then never applied. It carries the library's own
        //    per-size tuning, and it runs the other way to intuition: 1.75 at 20px down to 1.15 at
        //    64px, because a small orb needs proportionally FATTER dots to read at all. Dropping it
        //    removed the one correction aimed at exactly this problem.
        // 3. No rMin floor, which rubikDots has. The library floors every dot at 0.3px before
        //    painting; without it a sub-pixel dot renders as nothing rather than as a faint one.
        //
        // Expressed against uSize rather than a constant so it stays correct at every placement
        // instead of only at the size it was tuned on.
        //
        // sizeMul scales this DOWN at small placements — see its definition above for why that is the
        // opposite of the library's own preset. The rMin floor still applies underneath it, so
        // shrinking can never take a dot below the 0.3px the library guarantees.
        float rad = max(rMinUv(), (0.6 + 1.7 * f + L) * sizeMul / max(uSize * 0.5, 1.0)) * radiusMul;

        vec2 dpos = vec2(proj.x, -proj.y);
        float dist = length(nuv - dpos);
        float dotA = 1.0 - smoothstep(rad * 0.75, rad, dist);
        if (dotA > 0.0 && proj.z > bestDepth) {
          bestDepth = proj.z;
          // THE SCAN IS THE INK, not a highlight on top of already-solid dots. This had it inverted:
          // the base ran to 0.92 ink on the near face and the scan then ADDED white, so nearly every
          // dot sat solid chocolate and the sweep made them paler. The library does the opposite —
          // every dot rests at a low-opacity ink and only the meridian it is crossing reaches full
          // strength, which is what makes the sweep read as a sweep instead of as a wash.
          //
          // MEASURED off the library's own canvas rather than guessed: 665 dot cores sampled from
          // the searching orb at 64px, composited on its rgb(7,7,7) ground, so luminance/255 is ink
          // strength directly. Faintest 0.09, median 0.39, p75 0.49, peak 0.73. Note the peak is NOT
          // solid — even the shimmer stops around three-quarters.
          //
          // 'shade' here is the amount mixed toward the surface (see dotCol below), so it is the
          // inverse of ink: 0.90 far and 0.50 near reproduces that base spread, and the scan drives
          // it down by 0.30 to land a lit dot at ~0.80 ink.
          // (Single quotes, not backticks: this whole shader lives in a JS template literal.)
          shade = mix(0.90, 0.50, f) - L * 0.30;
        }
        cover = max(cover, dotA);
      }
    }
  }
  return cover;
}

// One form's dot field. Mesh is the absence of dots, so it simply contributes nothing and lets the
// smooth sphere already rendered underneath show through.
float formCover(float form, vec2 nuv, float tRaw, float radiusMul, out float shade) {
  shade = 0.0;
  if (form < 0.5) return 0.0;
  if (form < 1.5) return globeDots(nuv, tRaw, radiusMul, shade);
  return bandsDots(nuv, tRaw, radiusMul, shade);
}

void main() {
  // Centred, aspect-corrected, so the orb stays circular in any box.
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / min(uResolution.x, uResolution.y);
  float r = length(uv);

  // THE LOOP. Sampling noise along a circle means t and t+loopDuration hit the same point, so the
  // animation closes with no crossfade. uMotion is the radius of that circle: 0 freezes it.
  // PHASE ARRIVES AS A UNIFORM rather than being derived from uTime / uLoopDuration here.
  // Deriving it meant that changing loopDuration changed the phase INSTANTLY: at t=9s a loop of 9
  // gives 2*PI and a loop of 42 gives 1.35, so the sample point teleported to a different place on
  // its circle and the field visibly cut. Accumulating the phase on the JS side leaves it continuous
  // across any pace change; loopDuration now only sets how fast it accrues. uTime still drives the
  // dotted forms, which want a plain clock.
  float phase = uPhase;
  vec2 drift = vec2(cos(phase), sin(phase)) * uMotion;

  // CURVATURE bends the sample toward the sphere's surface, so lobes compress at the rim the way
  // they would on a ball rather than staying flat like a disc.
  float dome = sqrt(max(1.0 - r * r, 0.0));
  // 0.55 puts roughly one lobe across the orb at blobSize 1. Without it the noise coordinate spanned
  // ~2 units and produced a dozen small swirls instead of two masses.
  vec2 sample = uv * 0.55 * (1.0 + uCurvature * (1.0 - dome)) / max(uBlobSize, 0.05);

  // The mesh: two FBM lookups, the second warping the first. That warp is what turns separate blobs
  // into one connected field with curved seams.
  float n1 = fbm(sample + drift);
  // Warp scaled WAY down (was + n1, i.e. up to a full unit). A large warp is turbulence; a small one
  // is what curves the seam between the two colours, which is the actual goal.
  float n2 = fbm(sample * 1.4 - drift * 0.6 + n1 * 0.25);

  // An optional SPATIAL term alongside the noise, scaled by uColorSweep (default 0 — see the comment
  // on that parameter). At 0 the mix is noise-only, which is what the tuned defaults expect. Raised,
  // it guarantees the mix spans both colours however soft the noise gets, which is useful when two
  // distinct colours are wanted at a large blob size.
  float sweep = dot(uv, normalize(vec2(0.7, -0.72))) * uColorSweep;

  // COLOUR RIPPLE bands the mix so the two colours interleave rather than making one flat gradient.
  float mixv = 0.5 + 0.5 * sin((sweep + n1 + n2 * 0.6) * uColorRipple * 3.14159 + uPaletteShift * 6.28318);
  mixv = clamp(mixv + uColorBalance, 0.0, 1.0);

  vec3 col = mix(uColorA, uColorB, mixv);

  // SHADING: a sphere is darker where it turns away from us.
  col *= 1.0 - uShading * (1.0 - dome) * 4.0;

  // SPECULAR: one highlight from the light vector, tight and bright.
  vec3 normal = normalize(vec3(uv, dome + 0.001));
  vec3 lightDir = normalize(vec3(uLight, 1.0));
  float spec = pow(max(dot(normal, lightDir), 0.0), 24.0);
  col += spec * uSpecular;

  // RIM LIGHT: brightest exactly at the circumference, so the ball reads as lit from behind too.
  col += uRimLight * pow(smoothstep(0.55, 1.0, r), 2.0);

  // EDGE: the disc itself, plus an optional glow bleeding past it.
  float soft = max(uEdgeSoftness, 0.0005);
  float alpha = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, r);
  alpha += uGlow * (1.0 - smoothstep(1.0, 1.6, r)) * 0.6;

  // THE MORPH. As uDotted falls, the dots GROW (radiusMul climbs) so they swell into one another and
  // the gaps close, while the smooth mesh comes up underneath. That's why this is a transformation
  // rather than a crossfade: at 0.5 you are looking at fat merging dots over an emerging sphere, not
  // two orbs at half opacity.
  // How DOTTED we are overall: mesh contributes none, either dotted form contributes fully, and a
  // morph between them sits in between. This is what drives the swell — it is derived from the two
  // endpoints rather than being its own dial.
  float dotsFrom = uFormFrom < 0.5 ? 0.0 : 1.0;
  float dotsTo   = uFormTo   < 0.5 ? 0.0 : 1.0;
  float dots = mix(dotsFrom, dotsTo, clamp(uFormT, 0.0, 1.0));

  if (dots > 0.001) {
    float radiusMul = mix(9.0, 1.0, dots);
    float shadeA, shadeB;
    float coverA = formCover(uFormFrom, uv / G_R, uTime, radiusMul, shadeA);
    float coverB = formCover(uFormTo,   uv / G_R, uTime, radiusMul, shadeB);
    float ft = clamp(uFormT, 0.0, 1.0);
    float cover = mix(coverA, coverB, ft);
    float shade = mix(shadeA, shadeB, ft);

    // Depth washes the ink toward white rather than toward another hue, which is how dark-ink-on-light
    // recedes: far dots fade into the chip, near ones sit solid on it. The library expresses the same
    // thing as a greyscale 'white' value; this keeps the hue and moves the lightness.
    // The library's painter treats 'white' AS the grey level: rgba(w*255, w*255, w*255). Ours
    // keeps the chocolate hue and moves only lightness, so the faithful mapping is a straight mix
    // to white.
    vec3 dotCol = mix(uDotColor, vec3(1.0), clamp(shade, 0.0, 1.0));

    col = mix(col, dotCol, cover * dots);
    // Outside the dots the globe is transparent, so alpha follows coverage — that gap between dots is
    // what makes it read as dots at all.
    alpha = mix(alpha, cover, dots);
  }

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`

// Expands a state into its motion parameters, then lets the caller's own overrides win.
//
// TAKES THE STATE AND THE EXPLICIT PARAMS SEPARATELY, and that separation is load-bearing: merged
// into one object, previously RESOLVED params round-trip back in looking like caller overrides and
// beat the new state's own values — state changes after the first stop applying.
function resolve(state, explicit = {}) {
  const preset = state && ORB_STATES[state] ? ORB_STATES[state] : {}
  return { ...ORB_DEFAULTS, ...preset, ...explicit }
}

function hexToRgb(hex) {
  const h = hex.replace("#", "").trim()
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
  const n = parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function compile(gl, type, src) {
  const sh = gl.createShader(type)
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Surfaced rather than swallowed: a silent shader failure looks exactly like "the orb didn't
    // render", which is the hardest possible thing to debug from the outside.
    throw new Error(`agent-orb shader: ${gl.getShaderInfoLog(sh)}`)
  }
  return sh
}

// Returns a handle: { setParams, start, stop, destroy }. Null when WebGL is unavailable — the caller
// is expected to fall back to a plain fill rather than show nothing.
export function createOrb(canvas, params = {}) {
  // A `state` in params is shorthand for its motion pair; explicit params still win over it, so a
  // caller can say `state: "working"` and then override just the loop duration.
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: true })
  if (!gl) return null

  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`agent-orb link: ${gl.getProgramInfoLog(prog)}`)
  }
  gl.useProgram(prog)

  // One full-screen triangle pair; every pixel is the shader's problem.
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, "aPos")
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  const u = {}
  const NAMES = ["uResolution", "uTime", "uPhase", "uColorA", "uColorB", "uLoopDuration", "uBlobSize",
    "uMotion", "uColorBalance", "uPaletteShift", "uColorRipple", "uRimLight", "uSpecular",
    "uShading", "uCurvature", "uLight", "uEdgeSoftness", "uGlow", "uColorSweep", "uFormFrom", "uFormTo", "uFormT", "uDotColor", "uSize"]
  NAMES.forEach((n) => (u[n] = gl.getUniformLocation(prog, n)))

  // The caller's own parameters, kept apart from whatever a state resolved to — see resolve().
  const { state: initialState, ...initialExplicit } = params
  let stateName = initialState
  let explicit = initialExplicit
  let p = resolve(stateName, explicit)
  let raf = null
  let frozenAt = 0
  // THE ORB'S OWN CLOCK, which is not wall time. It advances at whatever rate driftRateAt returns —
  // always forward, sometimes barely. Scaling time rather than the sample radius is what makes
  // "slower" mean slower along the same path instead of smaller around a shrinking one.
  let orbTime = 0
  // THE DRIFT PHASE, accumulated rather than derived — see the uPhase note in the shader. This is the
  // value that must never jump, because it IS the sample's position on its circle.
  let orbPhase = 0
  // {from, to, startedAt} while a pace change is easing, null at rest. Phase continuity alone makes a
  // pace change seamless in POSITION; without this it is still instantaneous in SPEED, and an orb that
  // goes from visibly moving to nearly still between two frames reads as having been switched off.
  let paceTween = null
  let lastFrameAt = null
  // Per-orb phase offset into the drift wander, assigned on first use. See driftRateAt.
  let driftOffset = null
  // {from, to, t, startedAt, duration} while a form change is in flight, null at rest.
  let morph = null

  function resize() {
    // Cap DPR at 2: past that this is spending fill rate nobody can see.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
  }

  function draw(t) {
    resize()
    const a = hexToRgb(p.colorA)
    const b = hexToRgb(p.colorB)
    gl.uniform2f(u.uResolution, canvas.width, canvas.height)
    gl.uniform1f(u.uTime, t)
    gl.uniform1f(u.uPhase, orbPhase)
    gl.uniform3f(u.uColorA, a[0], a[1], a[2])
    gl.uniform3f(u.uColorB, b[0], b[1], b[2])
    gl.uniform1f(u.uLoopDuration, p.loopDuration)
    gl.uniform1f(u.uBlobSize, p.blobSize)
    gl.uniform1f(u.uMotion, p.motion)
    gl.uniform1f(u.uColorBalance, p.colorBalance)
    gl.uniform1f(u.uPaletteShift, p.paletteShift)
    gl.uniform1f(u.uColorRipple, p.colorRipple)
    gl.uniform1f(u.uRimLight, p.rimLight)
    gl.uniform1f(u.uSpecular, p.specular)
    gl.uniform1f(u.uShading, p.shading)
    gl.uniform1f(u.uCurvature, p.curvature)
    gl.uniform2f(u.uLight, p.lightX, p.lightY)
    gl.uniform1f(u.uEdgeSoftness, p.edgeSoftness)
    gl.uniform1f(u.uGlow, p.glow)
    gl.uniform1f(u.uColorSweep, p.colorSweep)
    // A morph in flight overrides the resting form; otherwise both ends are the same and t is moot.
    gl.uniform1f(u.uFormFrom, morph ? morph.from : formIndex(p.form))
    gl.uniform1f(u.uFormTo, morph ? morph.to : formIndex(p.form))
    gl.uniform1f(u.uFormT, morph ? morph.t : 0)
    const dc = hexToRgb(p.dotColor)
    gl.uniform3f(u.uDotColor, dc[0], dc[1], dc[2])
    // CSS px, not device px — the designs are tuned against rendered size, not DPR.
    gl.uniform1f(u.uSize, Math.max(1, canvas.clientWidth))
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // Advance a form morph. Driven off the SAME clock as the draw rather than its own timer, so a
  // stopped or frozen orb cannot leave a morph running past the last painted frame.
  function stepMorph(now) {
    if (!morph) return
    const elapsed = now - morph.startedAt
    const raw = morph.duration > 0 ? Math.min(1, elapsed / morph.duration) : 1
    // Same easing family as the card morph it usually accompanies.
    morph.t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2
    if (raw >= 1) {
      explicit = { ...explicit, form: morph.toName }
      p = resolve(stateName, explicit)
      morph = null
    }
  }

  // How fast the orb's clock is running right now — a multiplier on real time, never zero.
  //
  // WITHOUT A `drift` this is always 1 and the orb runs at its loopDuration, which is every state but
  // `idle`. With one, the rate wanders slowly within [min, max] so the movement ebbs and gathers
  // instead of proceeding at a constant crawl. A steady slow rate is still a metronome.
  //
  // TWO SINES AT PERIODS THAT DON'T DIVIDE INTO EACH OTHER (13s and 19s). Their sum repeats only
  // every ~247s, and unequally weighted so neither is individually legible. One sine alone is a
  // visible breathing rhythm; two are a wander.
  //
  // It scales the CLOCK rather than the motion amplitude, and that is deliberate. `motion` is the
  // radius of the circle the noise is sampled along, so scaling it down walks the sample toward the
  // centre of that circle — the pattern doesn't slow, it collapses inward and blooms back out.
  // Scaling the clock moves along the same path at a different speed, which is what "slower" means.
  function driftRateAt(now) {
    const d = p.drift
    if (!d) return 1

    // Per-orb offset, so two orbs on one screen are never at the same point in the wander. Set on
    // first use rather than at construction because an orb that never runs shouldn't need one.
    if (driftOffset === null) driftOffset = Math.random() * 1000
    const t = now / 1000 + driftOffset

    // 0..1, weighted so the longer period leads.
    const wander =
      0.5 +
      0.5 * (0.6 * Math.sin((2 * Math.PI * t) / d.periodB) + 0.4 * Math.sin((2 * Math.PI * t) / d.periodA))
    return d.min + (d.max - d.min) * wander
  }

  // The loop length in force right now — eased across a pace change rather than switched.
  function paceAt(now) {
    if (!paceTween) return p.loopDuration
    const raw = paceTween.duration > 0 ? (now - paceTween.startedAt) / paceTween.duration : 1
    if (raw >= 1) { paceTween = null; return p.loopDuration }
    // Same ease-in-out the card morph uses, so a pace change and a shape change feel related.
    const e = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2
    return paceTween.from + (paceTween.to - paceTween.from) * e
  }

  function tick(now) {
    // Clamped so a tab that was backgrounded for a minute resumes rather than jumping the noise field
    // a minute forward in one frame.
    const dt = lastFrameAt === null ? 0 : Math.min(0.05, (now - lastFrameAt) / 1000)
    lastFrameAt = now
    const rate = driftRateAt(now)
    orbTime += dt * rate
    // Angular velocity is 2*PI / loop, so easing the LOOP eases the speed and the phase keeps
    // accruing from wherever it had got to. Nothing resets, nothing jumps.
    orbPhase += dt * rate * ((2 * Math.PI) / Math.max(paceAt(now), 0.001))
    stepMorph(now)
    draw(orbTime)
    raf = requestAnimationFrame(tick)
  }

  return {
    setParams(next) {
      const { state: nextState, ...rest } = next
      if (nextState !== undefined) stateName = nextState
      explicit = { ...explicit, ...rest }

      // Ease the pace rather than switching it. Started from whatever loop is in force at this
      // instant — not from p.loopDuration — so a change that lands mid-tween continues from where the
      // orb actually is instead of snapping back to the last target and setting off again.
      const before = paceAt(performance.now())
      p = resolve(stateName, explicit)
      if (p.paceMs > 0 && Math.abs(before - p.loopDuration) > 0.001) {
        paceTween = { from: before, to: p.loopDuration, startedAt: performance.now(), duration: p.paceMs }
      }
      // Repaint immediately so a slider drag responds even while stopped.
      if (raf === null) draw(frozenAt)
    },
    params: () => ({ ...p }),
    // Change form over time. The orb has to be RUNNING for this to animate — a still orb has no
    // clock — so a morph requested while stopped lands instantly rather than half-applying.
    morphTo(form, ms) {
      const to = formIndex(form)
      const from = morph ? morph.to : formIndex(p.form)
      if (to === from) { morph = null; return }
      const duration = ms ?? p.morphMs
      if (raf === null || !(duration > 0)) {
        explicit = { ...explicit, form }
        p = resolve(stateName, explicit)
        morph = null
        draw(frozenAt)
        return
      }
      morph = { from, to, toName: form, t: 0, startedAt: performance.now(), duration }
    },
    start() {
      if (raf !== null) return
      lastFrameAt = null
      raf = requestAnimationFrame(tick)
    },
    stop() {
      if (raf === null) return
      cancelAnimationFrame(raf)
      raf = null
    },
    // A single frame at a fixed time — what reduced-motion gets, and what the playground's freeze
    // uses. The orb is identity, so stopping it must still SHOW it.
    //
    // Named `freeze`, not `still`. There is an ORB_STATES.still, and it is a different thing in a
    // way the shared name actively hid: that one is a STATE the orb runs in (motion 0 — the loop is
    // still turning, the form just doesn't drift), while this STOPS the render loop and paints one
    // frame. "Set it to still" and "make it still" read as the same instruction and are not.
    freeze(t = 0) {
      this.stop()
      frozenAt = t
      draw(t)
    },
    destroy() {
      this.stop()
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    }
  }
}

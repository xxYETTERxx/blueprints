import {
    BlockVolume,
    CommandPermissionLevel,
    CustomCommandParamType,
    CustomCommandStatus,
    GameMode,
    ItemStack,
    Player,
    StructureSaveMode,
    system,
    world,
} from "@minecraft/server";

// ---------------------------------------------------------------------------
// Block ids, states, storage keys
// ---------------------------------------------------------------------------

const COMPONENT = "blueprint:component_block";
const PIN_IN = "blueprint:pin_in";
const PIN_OUT = "blueprint:pin_out";
const FACING_STATE = "minecraft:cardinal_direction";
const ON_STATE = "blueprint:on";
const LIT_STATE = "blueprint:lit";
const LAST_STATE = "blueprint:last"; // inputs the block last acted on (0..7)
const STATUS_STATE = "blueprint:status"; // the side lights: "blank", "config" (testing), "ready"

const NEXT_DESIGN_KEY = "blueprint:next_design"; // world: next free design id
const DESIGN_KEY = (id) => `blueprint:design:${id}`; // world: JSON { built, table }
const INSTANCE_KEY = (key) => `blueprint:at:${key}`; // world: design id of a placed block
const RETURN_KEY = "blueprint:return"; // player: JSON stack of where to send them back (one per level entered)
const SLOT_KEY = (key) => `blueprint:slot:${key}`; // world: live slot of a placed block
const NEXT_SLOT_KEY = "blueprint:next_slot"; // world: next never-used live slot
const FREE_SLOTS_KEY = "blueprint:free_slots"; // world: JSON list of released live slots
const LIVE_AREA_KEY = "blueprint:live_area_2"; // world: true once the ticking area exists
const LIVE_FILLED_KEY = "blueprint:live_filled_2"; // world: true once the region is walled in barrier

// ---------------------------------------------------------------------------
// Build plots: one per design, in a row high above the Overworld, far away.
// Local layout (lx, lz in 0..PLOT_SIZE-1, centre M); the plot's north edge is the block's front:
//
//              out (M,0)
//    A (0,M)               C (last,M)      A = left, B = back, C = right
//              B (M,last)
// ---------------------------------------------------------------------------

const PLOT_X = 100000;
const PLOT_Y = 250; // build level; the floor is one below
const PLOT_Z = 100000;
const PLOT_SPACING = 32;
const PLOT_SIZE = 17; // must be odd so the pins sit in the middle of each edge
const PLOT_MID = (PLOT_SIZE - 1) / 2;
const PLOT_HEIGHT = 10; // air cleared above the floor when a plot is first built
const PIN_SPOTS = {
    out: { x: PLOT_MID, z: 0 },
    a: { x: 0, z: PLOT_MID },
    b: { x: PLOT_MID, z: PLOT_SIZE - 1 },
    c: { x: PLOT_SIZE - 1, z: PLOT_MID },
};

// ---------------------------------------------------------------------------
// Live region: every placed component runs a real copy of its design here. Each
// chunk column holds a stack of slots, walled in by barrier, and a ticking area
// keeps the whole region running even though no player is ever near it.
// ---------------------------------------------------------------------------

const LIVE_X = 300000;
const LIVE_Z = 300000;
const WORLD_BOTTOM = -64;
const WORLD_TOP = 319;
// The part of a build area that gets copied, relative to its plot origin (border and floor included).
const CAPTURE_LO = { x: -1, y: -2, z: -1 };
const CAPTURE_HI = { x: PLOT_SIZE, y: PLOT_HEIGHT, z: PLOT_SIZE };
const CAPTURE_SIZE = { x: PLOT_SIZE + 2, y: PLOT_HEIGHT + 3, z: PLOT_SIZE + 2 };
// Slots stand in columns with one barrier wall between them, stacked with one barrier layer between.
const SLOT_FOOTPRINT = CAPTURE_SIZE.x + 1;
const SLOT_HEIGHT = CAPTURE_SIZE.y + 1;
const LIVE_GRID = 2; // the region is LIVE_GRID x LIVE_GRID columns of slots
const LIVE_SPAN = LIVE_GRID * SLOT_FOOTPRINT + 1; // blocks across, walls included
const SLOTS_PER_COLUMN = Math.floor((WORLD_TOP - WORLD_BOTTOM + 1) / SLOT_HEIGHT);
const SLOT_CAPACITY = LIVE_GRID * LIVE_GRID * SLOTS_PER_COLUMN;

// Compile timing. After each flip the compiler watches every redstone part in the plot
// and moves on once nothing has changed for longer than the slowest part's delay.
const MAX_SETTLE_TICKS = 100; // still busy after this long: it's a clock
const MAX_SWEEP_STEPS = 300;
const CHECK_STEPS = 16; // extra steps that re-test a circuit with memory for hidden state

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

const FACES = {
    north: { x: 0, y: 0, z: -1 },
    south: { x: 0, y: 0, z: 1 },
    east: { x: 1, y: 0, z: 0 },
    west: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    down: { x: 0, y: -1, z: 0 },
};
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };
// Seen from behind the block looking out of its output face.
const LEFT_OF = { north: "west", east: "north", south: "east", west: "south" };
const RIGHT_OF = { north: "east", east: "south", south: "west", west: "north" };
// Old integer "direction" state used by some blocks (0 = south, 1 = west, 2 = north, 3 = east).
const LEGACY_DIRECTION = ["south", "west", "north", "east"];

const DIODES = new Set([
    "minecraft:powered_repeater",
    "minecraft:unpowered_repeater",
    "minecraft:powered_comparator",
    "minecraft:unpowered_comparator",
]);

function overworld() {
    return world.getDimension("minecraft:overworld");
}

function fmt(loc) {
    return `${loc.x}, ${loc.y}, ${loc.z}`;
}

/** Reads a true/false block state. */
function flag(block, state) {
    return block.permutation.getState(state) === true;
}

/** Sets a true/false block state, only touching the block when it changes. */
function setFlag(block, state, value) {
    if (flag(block, state) !== value) block.setPermutation(block.permutation.withState(state, value));
}

function neighbor(block, offset) {
    try {
        return block.offset(offset);
    } catch {
        return undefined; // unloaded chunk
    }
}

// ---------------------------------------------------------------------------
// Designs and placed instances
// ---------------------------------------------------------------------------

/** Storage key for a placed block: dimension and position. */
function instanceKey(block) {
    return locationKey(block.dimension.id, block.location);
}

function locationKey(dimensionId, location) {
    return `${dimensionId}|${location.x},${location.y},${location.z}`;
}

function loadDesign(id) {
    const raw = world.getDynamicProperty(DESIGN_KEY(id));
    return typeof raw === "string" ? JSON.parse(raw) : undefined;
}

function saveDesign(id, design) {
    world.setDynamicProperty(DESIGN_KEY(id), JSON.stringify(design));
    designCache.delete(id);
}

// Caches so the per-tick runtime doesn't parse JSON every time.
const instanceCache = new Map(); // instance key -> design id or 0
const designCache = new Map(); // design id -> parsed design (or null)

function designIdOf(block) {
    const key = instanceKey(block);
    let id = instanceCache.get(key);
    if (id === undefined) {
        const raw = world.getDynamicProperty(INSTANCE_KEY(key));
        id = typeof raw === "number" ? raw : 0;
        instanceCache.set(key, id);
    }
    return id;
}

function cachedDesign(id) {
    let design = designCache.get(id);
    if (design === undefined) {
        design = loadDesign(id) ?? null;
        designCache.set(id, design);
    }
    return design;
}

function tableOf(id) {
    return cachedDesign(id)?.table ?? "";
}

/** Design id of a placed block, creating a fresh empty design if it has none. */
function ensureDesign(block) {
    const existing = designIdOf(block);
    if (existing) return existing;
    const raw = world.getDynamicProperty(NEXT_DESIGN_KEY);
    const id = typeof raw === "number" ? raw : 1;
    world.setDynamicProperty(NEXT_DESIGN_KEY, id + 1);
    saveDesign(id, { built: false, table: "" });
    const key = instanceKey(block);
    world.setDynamicProperty(INSTANCE_KEY(key), id);
    instanceCache.set(key, id);
    return id;
}

function forgetInstance(dimensionId, location) {
    const key = locationKey(dimensionId, location);
    const raw = world.getDynamicProperty(INSTANCE_KEY(key));
    world.setDynamicProperty(INSTANCE_KEY(key), undefined);
    instanceCache.delete(key);
    releaseSlot(key, typeof raw === "number" ? raw : 0);
}

// ---------------------------------------------------------------------------
// Runtime: a placed component block reads its inputs and looks up its output
// ---------------------------------------------------------------------------

/** The way a repeater or comparator sends its output. Bedrock stores the opposite of it. */
function diodeOutput(n) {
    const states = n.permutation.getAllStates();
    const cardinal = states["minecraft:cardinal_direction"];
    if (typeof cardinal === "string") return OPPOSITE[cardinal];
    const legacy = states["direction"];
    return typeof legacy === "number" ? OPPOSITE[LEGACY_DIRECTION[legacy]] : undefined;
}

/**
 * True when the neighbor on this face is a real input that is on. Only inputs our own
 * output can't feed count: repeaters and comparators pointing in, and sources with their
 * own switch. Dust and plain blocks are ignored, since our output would light them too.
 */
function inputOn(block, face) {
    const n = neighbor(block, FACES[face]);
    if (n === undefined || n.isAir) return false;
    if (!((n.getRedstonePower() ?? 0) > 0)) return false;
    const id = n.typeId;
    if (DIODES.has(id)) return diodeOutput(n) === OPPOSITE[face];
    if (id === "minecraft:redstone_torch") {
        const facing = n.permutation.getAllStates()["torch_facing_direction"];
        return !(facing === face || (face === "up" && facing === "top")); // not one hung on us
    }
    return (
        id === PIN_IN ||
        id === "minecraft:lever" ||
        id === "minecraft:redstone_block" ||
        id.endsWith("_button") ||
        id.endsWith("_pressure_plate")
    );
}

/** Inputs packed into 0..7: bit 0 = left (A), bit 1 = back (B), bit 2 = right (C). */
function readInputs(block) {
    const facing = block.permutation.getState(FACING_STATE);
    return (
        (inputOn(block, LEFT_OF[facing]) ? 1 : 0) |
        (inputOn(block, OPPOSITE[facing]) ? 2 : 0) |
        (inputOn(block, RIGHT_OF[facing]) ? 4 : 0)
    );
}

/**
 * A compiled table answers: "the output was S, the inputs were X, then input BIT flipped:
 * what's the output now?" That covers memory (S) and edges (which input just changed),
 * so latches and edge-triggered flip-flops both work.
 * 48 entries: index = (S * 8 + X) * 3 + BIT.
 */
const TABLE_SIZE = 48;

function edgeIndex(state, x, bit) {
    return (state * 8 + x) * 3 + bit;
}

/**
 * Runs the table for the inputs that changed since last time. When several changed at
 * once they're applied one at a time (A, then B, then C), so there are never races.
 */
function tableUpdate(block, table) {
    const now = readInputs(block);
    const last = block.permutation.getState(LAST_STATE);
    if (now === last) return; // nothing changed: a settled circuit stays as it is
    let state = flag(block, ON_STATE) ? 1 : 0;
    let at = typeof last === "number" ? last : 0;
    for (let bit = 0; bit < 3; bit++) {
        if ((((now ^ at) >> bit) & 1) === 0) continue;
        state = table[edgeIndex(state, at, bit)] === "1" ? 1 : 0;
        at ^= 1 << bit;
    }
    block.setPermutation(block.permutation.withState(LAST_STATE, now).withState(ON_STATE, state === 1));
}

/** Compiled designs run from their table; everything else runs its live copy. */
function updateComponent(block) {
    const id = designIdOf(block);
    const design = id ? cachedDesign(id) : null;
    const saved = design && ((design.version ?? 0) > 0 || (design.table ?? "").length === TABLE_SIZE);
    const status = !saved ? "blank" : design.status === "config" ? "config" : "ready";
    if (block.permutation.getState(STATUS_STATE) !== status) {
        block.setPermutation(block.permutation.withState(STATUS_STATE, status));
    }
    if (!id) {
        setFlag(block, ON_STATE, false);
        return;
    }
    const table = tableOf(id);
    if (table.length === TABLE_SIZE) tableUpdate(block, table);
    else liveUpdate(block, id);
}

const ComponentRuntime = {
    onTick({ block }) {
        updateComponent(block);
    },
    // Tap with an empty hand to step inside. (Holding an item, sneak to place against it.)
    onPlayerInteract(event) {
        const { block, player } = event;
        if (!player || !emptyHanded(player)) return;
        system.run(() => enter(player, block).catch((e) => player.sendMessage(`§c[blueprint] Enter failed: ${e}`)));
    },
};

// ---------------------------------------------------------------------------
// Live copies
// ---------------------------------------------------------------------------

let debugLive = false; // /blueprint:debug: report how long signals take through live copies
const slotCache = new Map(); // instance key -> slot, or -1 for none
const liveTiming = new Map(); // instance key -> { x, since } for the debug readout

function structureName(id) {
    return `blueprint:design_${id}`;
}

function addVec(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** Lowest corner of a slot's copy. */
function slotCorner(slot) {
    const column = Math.floor(slot / SLOTS_PER_COLUMN);
    const layer = slot % SLOTS_PER_COLUMN;
    return {
        x: LIVE_X + 1 + (column % LIVE_GRID) * SLOT_FOOTPRINT,
        y: WORLD_BOTTOM + layer * SLOT_HEIGHT,
        z: LIVE_Z + 1 + Math.floor(column / LIVE_GRID) * SLOT_FOOTPRINT,
    };
}

/** Where a pin sits inside a slot's copy. */
function slotSpot(slot, spot) {
    return spotAt(slotOrigin(slot), spot);
}

/** The plot origin (same layout as a build area) of a slot's copy. */
function slotOrigin(slot) {
    return addVec(slotCorner(slot), { x: -CAPTURE_LO.x, y: -CAPTURE_LO.y, z: -CAPTURE_LO.z });
}

/** A pin or spot position relative to a plot origin (build area or slot copy). */
function spotAt(origin, spot) {
    return { x: origin.x + spot.x, y: origin.y, z: origin.z + spot.z };
}

function slotOf(key) {
    let slot = slotCache.get(key);
    if (slot === undefined) {
        const raw = world.getDynamicProperty(SLOT_KEY(key));
        slot = typeof raw === "number" ? raw : -1;
        slotCache.set(key, slot);
    }
    return slot;
}

function readJsonList(key) {
    const raw = world.getDynamicProperty(key);
    return typeof raw === "string" ? JSON.parse(raw) : [];
}

/** A free slot (reusing released ones first), or -1 when the region is full. */
function allocateSlot() {
    const free = readJsonList(FREE_SLOTS_KEY);
    if (free.length > 0) {
        const slot = free.pop();
        world.setDynamicProperty(FREE_SLOTS_KEY, JSON.stringify(free));
        return slot;
    }
    const raw = world.getDynamicProperty(NEXT_SLOT_KEY);
    const next = typeof raw === "number" ? raw : 0;
    if (next >= SLOT_CAPACITY) return -1;
    world.setDynamicProperty(NEXT_SLOT_KEY, next + 1);
    return next;
}

/** Gives back a placed block's slot, walling it up again so its old circuit stops. */
function releaseSlot(key, id) {
    const slot = slotOf(key);
    slotCache.delete(key);
    liveTiming.delete(key);
    if (slot < 0) return;
    if (id) forgetNested(slot, nestedOf(id)); // components inside the copy go too
    world.setDynamicProperty(SLOT_KEY(key), undefined);
    const free = readJsonList(FREE_SLOTS_KEY);
    free.push(slot);
    world.setDynamicProperty(FREE_SLOTS_KEY, JSON.stringify(free));
    try {
        const corner = slotCorner(slot);
        const far = addVec(corner, { x: CAPTURE_SIZE.x - 1, y: CAPTURE_SIZE.y - 1, z: CAPTURE_SIZE.z - 1 });
        overworld().fillBlocks(new BlockVolume(corner, far), "minecraft:barrier");
    } catch {
        // Region not loaded right now; the next copy stamped here overwrites it anyway.
    }
}

/** Component blocks inside a design: [dx, dy, dz, design id] relative to the copied box. */
function nestedOf(id) {
    return loadDesign(id)?.nested ?? [];
}

/** Unlinks the component blocks a copy in this slot contained (and their own copies). */
function forgetNested(slot, nested) {
    const corner = slotCorner(slot);
    for (const [dx, dy, dz] of nested) {
        forgetInstance("minecraft:overworld", { x: corner.x + dx, y: corner.y + dy, z: corner.z + dz });
    }
}

/** Creates the ticking area once, then waits for the region to be loaded. */
async function ensureLiveRegion() {
    const dim = overworld();
    const far = { x: LIVE_X + LIVE_SPAN - 1, y: 0, z: LIVE_Z + LIVE_SPAN - 1 };
    if (world.getDynamicProperty(LIVE_AREA_KEY) !== true) {
        try {
            dim.runCommand(`tickingarea add ${LIVE_X} 0 ${LIVE_Z} ${far.x} 0 ${far.z} blueprint_live2 true`);
        } catch {
            // Already exists, most likely.
        }
        world.setDynamicProperty(LIVE_AREA_KEY, true);
    }
    const corners = [
        { x: LIVE_X, y: 0, z: LIVE_Z },
        { x: far.x, y: 0, z: LIVE_Z },
        { x: LIVE_X, y: 0, z: far.z },
        far,
    ];
    let loaded = false;
    for (let i = 0; i < 400 && !loaded; i++) {
        loaded = corners.every((c) => dim.isChunkLoaded(c));
        if (!loaded) await system.waitTicks(1);
    }
    if (!loaded) return false;
    if (world.getDynamicProperty(LIVE_FILLED_KEY) !== true) {
        // First use: replace the region's terrain with solid barrier, a slice per tick.
        for (let y = WORLD_BOTTOM; y <= WORLD_TOP; y += 16) {
            const top = Math.min(y + 15, WORLD_TOP);
            dim.fillBlocks(new BlockVolume({ x: LIVE_X, y, z: LIVE_Z }, { x: far.x, y: top, z: far.z }), "minecraft:barrier");
            await system.waitTicks(1);
        }
        world.setDynamicProperty(LIVE_FILLED_KEY, true);
    }
    return true;
}

/** Saves a build area as its design's snapshot. The build area must be loaded. */
function snapshotDesign(id) {
    const dim = overworld();
    const o = plotOrigin(id);
    const lo = addVec(o, CAPTURE_LO);
    const hi = addVec(o, CAPTURE_HI);
    world.structureManager.delete(structureName(id));
    world.structureManager.createFromWorld(structureName(id), dim, lo, hi, {
        includeBlocks: true,
        includeEntities: false,
        saveMode: StructureSaveMode.World,
    });
    // Note which component blocks are inside, so every copy can link them to their designs.
    const nested = [];
    for (let y = lo.y; y <= hi.y; y++) {
        for (let x = lo.x; x <= hi.x; x++) {
            for (let z = lo.z; z <= hi.z; z++) {
                const block = dim.getBlock({ x, y, z });
                if (block?.typeId !== COMPONENT) continue;
                const child = designIdOf(block);
                if (child) nested.push([x - lo.x, y - lo.y, z - lo.z, child]);
            }
        }
    }
    return nested;
}

/** Gives a placed block a slot (if it lacks one) and stamps its design's snapshot into it. Returns ms taken. */
async function stampInstance(key, id, previousNested = [], depth = 0) {
    if (world.structureManager.get(structureName(id)) === undefined) return 0; // design never saved
    if (!(await ensureLiveRegion())) throw new Error("the live region didn't load");
    let slot = slotOf(key);
    if (slot < 0) {
        slot = allocateSlot();
        if (slot < 0) throw new Error(`all ${SLOT_CAPACITY} live slots are in use`);
        world.setDynamicProperty(SLOT_KEY(key), slot);
        slotCache.set(key, slot);
    } else {
        forgetNested(slot, previousNested); // the old copy's components
    }
    const started = Date.now();
    const corner = slotCorner(slot);
    world.structureManager.place(structureName(id), overworld(), corner);
    const ms = Date.now() - started;
    // Link the components inside this copy; each gets its own live copy in turn.
    for (const [dx, dy, dz, child] of nestedOf(id)) {
        if (child === id) continue; // a design can't contain itself
        const at = { x: corner.x + dx, y: corner.y + dy, z: corner.z + dz };
        // Blocks copied in by a structure may not start their tick; placing it again makes sure.
        const block = overworld().getBlock(at);
        if (block?.typeId === COMPONENT) {
            const permutation = block.permutation;
            block.setType("minecraft:air");
            block.setPermutation(permutation);
        }
        bindAt("minecraft:overworld", at, child, depth + 1);
    }
    return ms;
}

/** Every placed block of a design, by instance key. */
function instancesOf(id) {
    const keys = [];
    for (const prop of world.getDynamicPropertyIds()) {
        if (prop.startsWith("blueprint:at:") && world.getDynamicProperty(prop) === id) {
            keys.push(prop.slice("blueprint:at:".length));
        }
    }
    return keys;
}

/** Re-stamps every placed copy of a design (after it changed). */
async function restampDesign(id, previousNested) {
    const keys = instancesOf(id);
    let total = 0;
    for (const key of keys) {
        if (tableOf(id).length === TABLE_SIZE) {
            // Compiled: copies run from the table, so their live copies can go.
            const slot = slotOf(key);
            if (slot >= 0) forgetNested(slot, previousNested);
            releaseSlot(key, 0);
        } else {
            total += await stampInstance(key, id, previousNested);
        }
    }
    return { count: keys.length, ms: total };
}

/**
 * The bridge: copy this block's inputs onto its live copy's input pins, and its live
 * copy's output pin onto this block.
 */
function liveUpdate(block, id) {
    const key = instanceKey(block);
    const slot = slotOf(key);
    if (slot < 0) {
        setFlag(block, ON_STATE, false);
        return;
    }
    const dim = overworld();
    const x = readInputs(block);
    try {
        ["a", "b", "c"].forEach((name, bit) => {
            const pin = dim.getBlock(slotSpot(slot, PIN_SPOTS[name]));
            if (pin?.typeId === PIN_IN) setFlag(pin, ON_STATE, ((x >> bit) & 1) === 1);
        });
        const out = dim.getBlock(slotSpot(slot, PIN_SPOTS.out));
        if (out?.typeId !== PIN_OUT) return;
        const lit = flag(out, LIT_STATE);
        if (debugLive) reportTiming(key, x, lit, block);
        // Keep "last inputs" current too, so a switch to the compiled table starts in step.
        if (flag(block, ON_STATE) !== lit || block.permutation.getState(LAST_STATE) !== x) {
            block.setPermutation(block.permutation.withState(ON_STATE, lit).withState(LAST_STATE, x));
        }
    } catch {
        // Live region not loaded this tick.
    }
}

/** Debug: when the inputs change, note the tick; when the output follows, report the delay. */
function reportTiming(key, x, lit, block) {
    const timing = liveTiming.get(key);
    if (!timing || timing.x !== x) {
        liveTiming.set(key, { x, since: system.currentTick, out: timing?.out ?? lit });
        return;
    }
    if (timing.out !== lit) {
        world.sendMessage(`§7[live] ${fmt(block.location)} output → ${lit ? 1 : 0} after ${system.currentTick - timing.since} ticks§r`);
        timing.out = lit;
    }
}

// ---------------------------------------------------------------------------
// Plots
// ---------------------------------------------------------------------------

function plotOrigin(id) {
    return { x: PLOT_X + id * PLOT_SPACING, y: PLOT_Y, z: PLOT_Z };
}

function plotSpot(id, spot) {
    const o = plotOrigin(id);
    return { x: o.x + spot.x, y: o.y, z: o.z + spot.z };
}

/** The design id of the plot a location is standing in, or undefined. */
function plotAt(dimension, loc) {
    if (dimension.id !== "minecraft:overworld" || loc.y < PLOT_Y - 3) return undefined;
    const id = Math.round((loc.x - PLOT_X - PLOT_MID) / PLOT_SPACING);
    if (id < 1) return undefined;
    const o = plotOrigin(id);
    const reach = PLOT_MID + 3;
    if (Math.abs(loc.x - (o.x + PLOT_MID + 0.5)) > reach || Math.abs(loc.z - (o.z + PLOT_MID + 0.5)) > reach) return undefined;
    return id;
}

/** Waits until the plot's chunks are loaded (after a teleport). */
async function waitForPlot(id) {
    // The plot plus its border straddles up to four chunks, so check all four corners.
    const corners = [
        plotSpot(id, { x: -1, z: -1 }),
        plotSpot(id, { x: PLOT_SIZE, z: -1 }),
        plotSpot(id, { x: -1, z: PLOT_SIZE }),
        plotSpot(id, { x: PLOT_SIZE, z: PLOT_SIZE }),
    ];
    for (let i = 0; i < 200; i++) {
        if (corners.every((c) => overworld().isChunkLoaded(c))) return true;
        await system.waitTicks(1);
    }
    return false;
}

/** Lays out a new plot: clears the air, floor with a dark border. Then makes sure the pins exist. */
function buildPlot(id) {
    const dim = overworld();
    const o = plotOrigin(id);
    const design = loadDesign(id);
    if (design && !design.built) {
        dim.fillBlocks(
            new BlockVolume({ x: o.x - 1, y: o.y, z: o.z - 1 }, { x: o.x + PLOT_SIZE, y: o.y + PLOT_HEIGHT, z: o.z + PLOT_SIZE }),
            "minecraft:air"
        );
        dim.fillBlocks(
            new BlockVolume({ x: o.x - 1, y: o.y - 1, z: o.z - 1 }, { x: o.x + PLOT_SIZE, y: o.y - 1, z: o.z + PLOT_SIZE }),
            "minecraft:polished_blackstone"
        );
        dim.fillBlocks(
            new BlockVolume({ x: o.x, y: o.y - 1, z: o.z }, { x: o.x + PLOT_SIZE - 1, y: o.y - 1, z: o.z + PLOT_SIZE - 1 }),
            "minecraft:smooth_stone"
        );
        design.built = true;
        saveDesign(id, design);
    }
    for (const [name, spot] of Object.entries(PIN_SPOTS)) {
        const block = dim.getBlock(plotSpot(id, spot));
        const type = name === "out" ? PIN_OUT : PIN_IN;
        if (block && block.typeId !== type) block.setType(type);
    }
}

// ---------------------------------------------------------------------------
// Pins inside a plot
// ---------------------------------------------------------------------------

const compiling = new Set(); // design ids being compiled right now

// Input pins: tap to toggle while building, so you can try your circuit.
const InputPin = {
    onPlayerInteract(event) {
        const block = event.block;
        const id = plotAt(block.dimension, block.location);
        if (id !== undefined && compiling.has(id)) return;
        const on = !flag(block, ON_STATE);
        setFlag(block, ON_STATE, on);
        event.player?.onScreenDisplay.setActionBar(on ? "Input on" : "Input off");
    },
};

// Output pin: lights up like a lamp when the circuit powers it.
const OutputPin = {
    onRedstoneUpdate({ block, powerLevel }) {
        setFlag(block, LIT_STATE, powerLevel > 0);
    },
    // Tap the lamp in a build area with an empty hand to save and leave.
    onPlayerInteract(event) {
        const { block, player } = event;
        if (!player || !emptyHanded(player)) return;
        const id = plotAt(block.dimension, block.location);
        if (id !== undefined) system.run(() => finish(player, id));
    },
};

function setInputs(origin, x) {
    const dim = overworld();
    ["a", "b", "c"].forEach((name, bit) => {
        const block = dim.getBlock(spotAt(origin, PIN_SPOTS[name]));
        if (block?.typeId !== PIN_IN) throw new Error(`input pin ${name.toUpperCase()} is missing`);
        setFlag(block, ON_STATE, ((x >> bit) & 1) === 1);
    });
}

function readOutput(origin) {
    const block = overworld().getBlock(spotAt(origin, PIN_SPOTS.out));
    if (block?.typeId !== PIN_OUT) throw new Error("output pin is missing");
    return flag(block, LIT_STATE) ? 1 : 0;
}

/** Worst-case delay in game ticks of a block that shows redstone activity, or undefined. */
function redstoneDelay(block) {
    const id = block.typeId;
    if (id === "minecraft:powered_repeater" || id === "minecraft:unpowered_repeater") {
        const delay = block.permutation.getAllStates()["repeater_delay"];
        return ((typeof delay === "number" ? delay : 3) + 1) * 2;
    }
    if (id.includes("piston")) return 6;
    if (id === COMPONENT) return 4; // a nested (compiled) component answers within its tick
    if (
        id === PIN_IN ||
        id === PIN_OUT ||
        id.includes("redstone") || // dust, torches, lamps, redstone block
        id.includes("comparator") ||
        id.includes("observer") ||
        id.includes("lever") ||
        id.includes("button")
    ) {
        return 2;
    }
    return undefined;
}

/**
 * Finds every redstone part in a plot (floor included) so the compiler can tell when the
 * circuit has gone quiet. The quiet window is one tick longer than the slowest part.
 */
function watchPlot(o) {
    const dim = overworld();
    const blocks = [];
    let slowest = 2;
    for (let y = o.y - 2; y <= o.y + PLOT_HEIGHT; y++) {
        for (let x = 0; x < PLOT_SIZE; x++) {
            for (let z = 0; z < PLOT_SIZE; z++) {
                const block = dim.getBlock({ x: o.x + x, y, z: o.z + z });
                if (!block) continue;
                const delay = redstoneDelay(block);
                if (delay === undefined) continue;
                blocks.push(block);
                slowest = Math.max(slowest, delay);
            }
        }
    }
    return { blocks, window: slowest + 1 };
}

/** A snapshot of every watched part, to compare tick to tick. */
function signature(watch) {
    return watch.blocks
        .map((b) => (b.isValid ? `${b.typeId}${JSON.stringify(b.permutation.getAllStates())}` : "-"))
        .join("|");
}

/** Waits until nothing in the circuit has changed for the quiet window, then reads the output. */
async function settledOutput(origin, watch) {
    let last = signature(watch);
    let quiet = 0;
    for (let waited = 1; waited <= MAX_SETTLE_TICKS; waited++) {
        await system.waitTicks(1);
        const now = signature(watch);
        if (now !== last) {
            last = now;
            quiet = 0;
        } else if (++quiet >= watch.window) {
            return readOutput(origin);
        }
    }
    throw new Error("the circuit never went quiet (is there a clock inside?)");
}

// ---------------------------------------------------------------------------
// Compiling: drive the input pins one flip at a time, like a careful player
// flipping levers, and record the output after each flip. The answer is keyed by
// the output before the flip, the inputs before the flip, and which input flipped,
// so latches (memory) and edge-triggered flip-flops (which input just changed)
// both compile. The walk tries every flip from every reachable situation; if
// the same flip from the same situation ever gives a different answer, the
// circuit hides state the output doesn't show, and the compile stops.
// ---------------------------------------------------------------------------

async function sweep(origin) {
    const table = new Array(TABLE_SIZE).fill(null);
    const watch = watchPlot(origin);

    setInputs(origin, 0);
    let x = 0;
    let state = await settledOutput(origin, watch);
    let count = 0;

    /** Flips one input, checks/records what happened, and moves there. */
    const step = async (bit, done, label) => {
        if (++count > MAX_SWEEP_STEPS) throw new Error("the walk took too many steps");
        const index = edgeIndex(state, x, bit);
        done.add(index);
        const next = x ^ (1 << bit);
        setInputs(origin, next);
        const out = await settledOutput(origin, watch);
        if (table[index] !== null && table[index] !== out) {
            throw new Error(
                "the same flip gave different outputs. The circuit remembers something the output pin " +
                    "doesn't show, or depends on timing. Split it into components with one bit of memory each."
            );
        }
        table[index] = out;
        x = next;
        state = out;
    };

    // Pass 1 learns every reachable flip. If the circuit turned out to have memory, pass 2
    // re-walks flips from wherever pass 1 ended for a few steps, to catch hidden state.
    for (const label of ["Compiling", "Checking"]) {
        if (label === "Checking" && truthTable(table) !== undefined) break;
        const done = new Set();
        const limit = label === "Checking" ? count + CHECK_STEPS : MAX_SWEEP_STEPS;
        while (count < limit) {
            const pending = (s, nx) => [0, 1, 2].find((bit) => !done.has(edgeIndex(s, nx, bit)));
            const bit = pending(state, x);
            if (bit !== undefined) {
                await step(bit, done, label);
                continue;
            }
            const path = pathToPending(table, state, x, pending);
            if (path === undefined) break; // every reachable flip done in this pass
            await step(path[0], done, label);
        }
    }

    setInputs(origin, 0);
    // Situations that never came up borrow the other state's answer.
    return table.map((v, i) => String(v ?? table[(i + 24) % TABLE_SIZE] ?? 0)).join("");
}

/** Breadth-first search over known flips to a situation with a pending flip; returns the bits to flip. */
function pathToPending(table, state, x, pending) {
    const start = state * 8 + x;
    /** @type {Map<number, { node: number, bit: number }>} situation -> how we got there */
    const cameFrom = new Map();
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
        const node = /** @type {number} */ (queue.shift());
        const s = node >> 3;
        const nx = node & 7;
        if (node !== start && pending(s, nx) !== undefined) {
            const bits = [];
            for (let at = node; at !== start; ) {
                const from = /** @type {{ node: number, bit: number }} */ (cameFrom.get(at));
                bits.unshift(from.bit);
                at = from.node;
            }
            return bits;
        }
        for (const bit of [0, 1, 2]) {
            const out = table[edgeIndex(s, nx, bit)];
            if (out === null) continue;
            const next = out * 8 + (nx ^ (1 << bit));
            if (!seen.has(next)) {
                seen.add(next);
                cameFrom.set(next, { node, bit });
                queue.push(next);
            }
        }
    }
    return undefined;
}

/**
 * The plain truth table (output for each input combination) if the output only depends
 * on the current inputs, or undefined if the circuit has memory. Unknown entries are skipped.
 */
function truthTable(table) {
    const result = [];
    for (let x = 0; x < 8; x++) {
        // Every way of landing on inputs x: from either output, by flipping any input.
        const outs = new Set();
        for (const s of [0, 1]) {
            for (const bit of [0, 1, 2]) {
                const v = table[edgeIndex(s, x ^ (1 << bit), bit)];
                if (v !== null) outs.add(String(v));
            }
        }
        if (outs.size > 1) return undefined;
        result.push(outs.size === 1 ? [...outs][0] : "0");
    }
    return result;
}

/** Plain-language view of a compiled table, for chat. */
function describeTable(table) {
    const plain = truthTable([...table]);
    if (plain === undefined) return "  §dSequential: it remembers (latch / flip-flop style).§r";
    return `  ABC: ${plain.map((out, x) => `${x & 1}${(x >> 1) & 1}${(x >> 2) & 1}→${out}`).join("  ")}`;
}

// ---------------------------------------------------------------------------
// Background compiling: after a save, a scratch copy is stamped into a spare live
// slot and put through the input test while placed copies keep running live. If
// the test proves a table, placed copies switch to it and free their live slots;
// if not, they simply stay live. The side lights show "testing" until it's done.
// ---------------------------------------------------------------------------

const CHILD_WAIT_TICKS = 1200; // how long a design waits for the components inside it to finish testing

async function backgroundCompile(id) {
    const design = loadDesign(id);
    if (!design) return;
    const version = design.version;
    const finishWith = (table, note) => {
        const now = loadDesign(id);
        if (!now || now.version !== version) return false; // edited again meanwhile; that save has its own test
        now.table = table;
        now.status = "ready";
        now.note = note;
        saveDesign(id, now);
        return true;
    };

    // A design is only compiled if everything inside it is compiled too.
    for (let waited = 0; ; waited += 20) {
        const children = (design.nested ?? []).map(([, , , child]) => cachedDesign(child));
        if (children.some((c) => !c)) return void finishWith("", "runs live: contains a deleted component");
        if (children.every((c) => c?.status !== "config")) {
            if (children.some((c) => (c?.table ?? "").length !== TABLE_SIZE)) {
                return void finishWith("", "runs live: contains live components");
            }
            break;
        }
        if (waited >= CHILD_WAIT_TICKS) return void finishWith("", "runs live: inner components took too long");
        await system.waitTicks(20);
    }

    const key = `scratch|${id}|${version}`;
    const nested = design.nested ?? [];
    try {
        await stampInstance(key, id);
        const slot = slotOf(key);
        if (slot < 0) return void finishWith("", "runs live: no spare slot to test in");
        await system.waitTicks(10); // let the copy (and anything inside) start up
        const table = await sweep(slotOrigin(slot));
        if (finishWith(table, truthTable([...table]) ? "compiled: logic" : "compiled: memory")) {
            await restampDesign(id, nested); // compiled copies give up their live slots
        }
    } catch (e) {
        finishWith("", `runs live: ${e instanceof Error ? e.message : e}`);
    } finally {
        const slot = slotOf(key);
        if (slot >= 0) forgetNested(slot, nested);
        releaseSlot(key, 0);
    }
}

// ---------------------------------------------------------------------------
// Entering and leaving
// ---------------------------------------------------------------------------

/** The stack of places a player came from, one per level entered (outermost first). */
function returnStack(player) {
    const raw = player.getDynamicProperty(RETURN_KEY);
    if (typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed]; // older saves held a single spot
}

/** Sends the player back one level: to the build area they entered from, or out to the world. */
function sendBack(player) {
    const stack = returnStack(player);
    const back = stack.pop();
    if (!back) {
        player.sendMessage("No return point saved.");
        return;
    }
    player.teleport(
        { x: back.x, y: back.y, z: back.z },
        { dimension: world.getDimension(back.dim), rotation: { x: back.rx, y: back.ry } }
    );
    player.setDynamicProperty(RETURN_KEY, stack.length ? JSON.stringify(stack) : undefined);
}

async function enter(player, block) {
    const id = ensureDesign(block);
    const r = player.getRotation();
    const l = player.location;
    const stack = returnStack(player);
    stack.push({ dim: player.dimension.id, x: l.x, y: l.y, z: l.z, rx: r.x, ry: r.y });
    player.setDynamicProperty(RETURN_KEY, JSON.stringify(stack));

    const o = plotOrigin(id);
    const spawn = { x: o.x + PLOT_MID + 0.5, y: PLOT_Y, z: o.z + PLOT_MID + 2.5 };
    const facing = { dimension: overworld(), facingLocation: plotSpot(id, PIN_SPOTS.out) };
    player.addEffect("slow_falling", 100, { showParticles: false });
    player.teleport({ ...spawn, y: PLOT_Y + 3 }, facing);
    if (!(await waitForPlot(id))) {
        player.sendMessage("§cThe build area didn't load. Try again.");
        return;
    }
    buildPlot(id);
    player.teleport(spawn, facing); // onto the floor, in case they fell before it loaded
    player.sendMessage(
        `§e[blueprint]§r Inside component #${id}. Lamp = output (the block's front). ` +
            `Blue pins = inputs A (left), B (back), C (right); tap them to test. ` +
            `§aTap the lamp with an empty hand§r to save and leave (§7/blueprint:exit§r leaves without saving).`
    );
}

/** True when the player's selected hotbar slot is empty. */
function emptyHanded(player) {
    const container = player.getComponent("minecraft:inventory")?.container;
    return container !== undefined && container.getItem(player.selectedSlotIndex) === undefined;
}

/** Snapshot the build area, update every placed copy, and report. */
async function saveAndStamp(player, id) {
    const previousNested = nestedOf(id);
    const nested = snapshotDesign(id);
    const design = loadDesign(id) ?? { built: true, table: "" };
    design.table = ""; // runs live until the background test proves a table
    design.nested = nested;
    design.version = (design.version ?? 0) + 1;
    design.status = "config";
    design.note = "";
    saveDesign(id, design);
    const { count, ms } = await restampDesign(id, previousNested);
    const copies = count === 1 ? "1 placed copy" : `${count} placed copies`;
    player.sendMessage(`§e[blueprint]§r Design #${id} saved. Updated ${copies}` + (count ? ` in ${ms} ms.` : "."));
    backgroundCompile(id).catch((e) => world.sendMessage(`§c[blueprint] Background test of #${id} crashed: ${e}`));
}

/** /blueprint:done — save the design as built and go back. Placed copies run it live. */
async function finish(player, id) {
    if (compiling.has(id)) return;
    compiling.add(id);
    try {
        setInputs(plotOrigin(id), 0); // save with every input off, so new copies start from a known state
        await system.waitTicks(10);
        await saveAndStamp(player, id);
        sendBack(player);
    } catch (e) {
        player.sendMessage(`§c[blueprint] Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
        compiling.delete(id);
    }
}


// ---------------------------------------------------------------------------
// Housekeeping: list designs, delete unused ones
// ---------------------------------------------------------------------------

/** All design ids, and how many placed blocks use each. */
function designCensus() {
    const designs = new Map(); // id -> placed count
    for (const key of world.getDynamicPropertyIds()) {
        if (key.startsWith("blueprint:design:")) {
            const id = Number(key.slice("blueprint:design:".length));
            if (!designs.has(id)) designs.set(id, 0);
        }
    }
    for (const key of world.getDynamicPropertyIds()) {
        if (!key.startsWith("blueprint:at:")) continue;
        const id = world.getDynamicProperty(key);
        if (typeof id === "number" && designs.has(id)) designs.set(id, (designs.get(id) ?? 0) + 1);
    }
    return designs;
}

function listDesigns(player) {
    const designs = [...designCensus()].sort((a, b) => a[0] - b[0]);
    if (designs.length === 0) {
        player.sendMessage("§e[blueprint]§r No designs yet.");
        return;
    }
    const lines = designs.map(
        ([id, placed]) => {
            const name = cachedDesign(id)?.name;
            return `  #${id}${name ? ` "${name}"` : ""}  ${designKind(id)}  §7${placed} placed${placed ? "" : " (only in items, or unused)"}§r`;
        }
    );
    const raw = world.getDynamicProperty(NEXT_SLOT_KEY);
    const used = (typeof raw === "number" ? raw : 0) - readJsonList(FREE_SLOTS_KEY).length;
    player.sendMessage(`§e[blueprint]§r Designs (live slots in use: ${used}/${SLOT_CAPACITY}):\n${lines.join("\n")}`);
}

/**
 * Deletes a design: its data goes, and its build area is cleared. Refused while any placed
 * block uses it. Items still carrying its number become blank when placed. Ids are never
 * reused, so an old item can't turn into a different circuit.
 */
async function deleteDesign(player, id) {
    const design = loadDesign(id);
    if (!design) {
        player.sendMessage(`§c[blueprint] There's no design #${id}.`);
        return;
    }
    const placed = designCensus().get(id) ?? 0;
    if (placed > 0) {
        player.sendMessage(`§c[blueprint] Design #${id} is placed ${placed} time(s). Break those first.`);
        return;
    }
    if (plotAt(player.dimension, player.location) === id || compiling.has(id)) {
        player.sendMessage(`§c[blueprint] Leave design #${id}'s build area first.`);
        return;
    }
    if (design.built) {
        // Load the far-away plot with a temporary ticking area, clear it, then let it go.
        const dim = overworld();
        const o = plotOrigin(id);
        const name = `blueprint_clear_${id}`;
        const lo = { x: o.x - 1, y: o.y - 3, z: o.z - 1 };
        const hi = { x: o.x + PLOT_SIZE, y: o.y + PLOT_HEIGHT, z: o.z + PLOT_SIZE };
        dim.runCommand(`tickingarea add ${lo.x} ${lo.y} ${lo.z} ${hi.x} ${hi.y} ${hi.z} ${name}`);
        try {
            let loaded = false;
            for (let i = 0; i < 200 && !loaded; i++) {
                await system.waitTicks(1);
                loaded = [lo, hi, { x: lo.x, y: lo.y, z: hi.z }, { x: hi.x, y: lo.y, z: lo.z }].every((c) =>
                    dim.isChunkLoaded(c)
                );
            }
            if (!loaded) throw new Error("the build area didn't load");
            dim.fillBlocks(new BlockVolume(lo, hi), "minecraft:air");
        } finally {
            dim.runCommand(`tickingarea remove ${name}`);
        }
    }
    world.setDynamicProperty(DESIGN_KEY(id), undefined);
    world.structureManager.delete(structureName(id));
    designCache.delete(id);
    player.sendMessage(`§e[blueprint]§r Design #${id} deleted.`);
}

// ---------------------------------------------------------------------------
// Commands and events
// ---------------------------------------------------------------------------

/** The component block the player is looking at, or undefined. */
function lookedAtComponent(player) {
    const hit = player.getBlockFromViewDirection({ maxDistance: 10 });
    return hit?.block.typeId === COMPONENT ? hit.block : undefined;
}

function probe(player, block) {
    const id = designIdOf(block);
    const design = id ? cachedDesign(id) : null;
    const table = id ? tableOf(id) : "";
    const x = readInputs(block);
    const out = flag(block, ON_STATE) ? 1 : 0;
    const slot = slotOf(instanceKey(block));
    const mode = !id ? "blank" : table.length === TABLE_SIZE ? "compiled" : slot >= 0 ? `live (slot ${slot})` : "no live copy";
    const status = design?.status === "config" ? "  §6testing...§r" : design?.note ? `  §7(${design.note})§r` : "";
    player.sendMessage(
        `§e[probe] ${fmt(block.location)}§r design=${id || "none"}${design?.name ? ` "${design.name}"` : ""}  ${mode}  ` +
            `inputs ABC=${x & 1}${(x >> 1) & 1}${(x >> 2) & 1}  out=${out}${status}` +
            (table.length === TABLE_SIZE ? `\n${describeTable(table)}` : "")
    );
}

/** Registers a player-only command whose body runs on the next tick. */
function playerCommand(registry, name, description, body) {
    registry.registerCommand(
        { name, description, permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const player = origin.sourceEntity;
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Run this as a player." };
            }
            system.run(() => body(player));
            return { status: CustomCommandStatus.Success };
        }
    );
}

system.beforeEvents.startup.subscribe(({ blockComponentRegistry, customCommandRegistry }) => {
    blockComponentRegistry.registerCustomComponent("blueprint:gate", ComponentRuntime);
    blockComponentRegistry.registerCustomComponent("blueprint:pin_in", InputPin);
    blockComponentRegistry.registerCustomComponent("blueprint:pin_out", OutputPin);

    playerCommand(customCommandRegistry, "blueprint:enter", "Step inside the component block you are looking at", (player) => {
        const block = lookedAtComponent(player);
        if (!block) {
            player.sendMessage("Not looking at a Component Block.");
            return;
        }
        enter(player, block).catch((e) => player.sendMessage(`§c[blueprint] Enter failed: ${e}`));
    });


    playerCommand(customCommandRegistry, "blueprint:done", "Save the component you are building and go back", (player) => {
        const id = plotAt(player.dimension, player.location);
        if (id === undefined) {
            player.sendMessage("You're not inside a component.");
            return;
        }
        finish(player, id);
    });

    playerCommand(customCommandRegistry, "blueprint:debug", "Toggle live-copy timing reports", (player) => {
        debugLive = !debugLive;
        player.sendMessage(`§e[blueprint]§r Live timing reports ${debugLive ? "on" : "off"}.`);
    });

    playerCommand(customCommandRegistry, "blueprint:exit", "Leave the component without saving", (player) => {
        sendBack(player);
    });

    playerCommand(customCommandRegistry, "blueprint:probe", "Show the inputs, output and table of the component you are looking at", (player) => {
        const block = lookedAtComponent(player);
        if (block) probe(player, block);
        else player.sendMessage("Not looking at a Component Block.");
    });

    playerCommand(customCommandRegistry, "blueprint:designs", "List every component design and how many are placed", (player) => {
        listDesigns(player);
    });

    // /blueprint:delete <id> — remove a design and clear its build area.
    customCommandRegistry.registerCommand(
        {
            name: "blueprint:delete",
            description: "Delete a component design that isn't placed anywhere, and clear its build area",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
            mandatoryParameters: [{ name: "id", type: CustomCommandParamType.Integer }],
        },
        (origin, id) => {
            const player = origin.sourceEntity;
            if (!(player instanceof Player)) {
                return { status: CustomCommandStatus.Failure, message: "Run this as a player." };
            }
            system.run(() => {
                deleteDesign(player, id).catch((e) => player.sendMessage(`§c[blueprint] Delete failed: ${e}`));
            });
            return { status: CustomCommandStatus.Success };
        }
    );
});

// ---------------------------------------------------------------------------
// Carrying designs on items. Block items can stack, and only non-stacking items can
// hold hidden data, so the design rides in the item's lore ("Component #12"). Copies
// of the same design have the same lore, so they stack like any other block.
// ---------------------------------------------------------------------------

const DESIGN_LORE = /Component #(\d+)/;

/** Design id carried by a Component Block item, or 0 for a blank one. */
function designFromItem(item) {
    if (item?.typeId !== COMPONENT) return 0;
    for (const line of item.getLore()) {
        const match = DESIGN_LORE.exec(line);
        if (match) return Number(match[1]);
    }
    return 0;
}

/** A short label for what a design does. */
function designKind(id) {
    const table = tableOf(id);
    if (table.length === TABLE_SIZE) return truthTable([...table]) ? "Logic (compiled)" : "Memory (compiled)";
    return isSaved(id) ? "Live" : "Not built";
}

/** True once a design has been saved with /blueprint:done. */
function isSaved(id) {
    const design = cachedDesign(id);
    return !!design && ((design.version ?? 0) > 0 || (design.table ?? "").length === TABLE_SIZE);
}

/** A Component Block item carrying a design (or a blank one for id 0). */
function designItem(id, amount = 1) {
    const item = new ItemStack(COMPONENT, amount);
    const design = id ? cachedDesign(id) : null;
    if (!design) return item; // blank, or a design that was deleted
    item.setLore([`§7Component #${id}`, `§8${designKind(id)}`]);
    if (design.name) item.nameTag = design.name;
    return item;
}

/** Links a placed block to a design (0 = blank), replacing any stale link at that spot. */
function bindInstance(block, id) {
    bindAt(block.dimension.id, block.location, id);
}

const MAX_NESTING = 8;

/** Links the block at a location to a design and, if the design runs live, gives it a live copy. */
function bindAt(dimensionId, location, id, depth = 0) {
    forgetInstance(dimensionId, location);
    if (!id || loadDesign(id) === undefined) return; // blank, or a deleted design
    const key = locationKey(dimensionId, location);
    world.setDynamicProperty(INSTANCE_KEY(key), id);
    instanceCache.set(key, id);
    if (world.structureManager.get(structureName(id)) === undefined || tableOf(id).length === TABLE_SIZE) return; // nothing to run, or compiled
    if (depth > MAX_NESTING) {
        world.sendMessage(`§c[blueprint] Components nested more than ${MAX_NESTING} deep (or inside themselves) don't run.`);
        return;
    }
    stampInstance(key, id, [], depth)
        .then((ms) => {
            if (debugLive) world.sendMessage(`§7[live] copy of #${id} stamped in ${ms} ms§r`);
        })
        .catch((e) => world.sendMessage(`§c[blueprint] Couldn't start a live copy: ${e}`));
}

// ---------------------------------------------------------------------------
// Copying by crafting, like maps: a saved component + a blank one makes two copies.
// (Naming is done the vanilla way, in an anvil; see refreshItem.)
// Recipes can't read item data, so the recipe makes two "unwritten copy" items, and
// the script writes the design onto them: the one whose component most recently
// went from the player's inventory into the crafting grid. The same inventory scan
// keeps names and labels on component items up to date.
// ---------------------------------------------------------------------------

const COPY_ITEM = "blueprint:component_copy";
const LAST_TAKEN_KEY = "blueprint:last_taken"; // player: the saved design that most recently left their inventory
const lastCounts = new Map(); // player id -> Map(design id -> how many they carried)
let trackerFailed = false; // report a scan error once, not every quarter second

/** Rewrites a component item if its name or label is out of date. */
/**
 * Keeps a component item's name and label in step with its design. A name the design has
 * never had means the player renamed the item in an anvil: that becomes the design's name
 * (and so the name of every copy). A name it used to have is just an old item catching up.
 */
function refreshItem(container, slot, item) {
    const id = designFromItem(item);
    if (!id) return;
    const design = cachedDesign(id);
    if (design && item.nameTag && item.nameTag !== design.name && !(design.oldNames ?? []).includes(item.nameTag)) {
        const updated = loadDesign(id);
        if (updated) {
            if (updated.name) updated.oldNames = [...(updated.oldNames ?? []), updated.name].slice(-20);
            updated.name = item.nameTag;
            saveDesign(id, updated);
        }
    }
    const fresh = designItem(id, item.amount);
    if (item.nameTag !== fresh.nameTag || item.getLore().join("|") !== fresh.getLore().join("|")) {
        container.setItem(slot, fresh);
    }
}

function trackInventory(player) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return;
    const counts = new Map();
    const tally = (item) => {
        const id = designFromItem(item);
        if (id) counts.set(id, (counts.get(id) ?? 0) + item.amount);
    };
    const cursor = player.getComponent("minecraft:cursor_inventory")?.item;
    if (cursor) tally(cursor);
    const copies = [];
    for (let slot = 0; slot < container.size; slot++) {
        const item = container.getItem(slot);
        if (!item) continue;
        if (item.typeId === COPY_ITEM) copies.push(slot);
        else if (item.typeId === COMPONENT) {
            tally(item);
            refreshItem(container, slot, item);
        }
    }
    // A saved component that left the inventory most likely went into a crafting grid.
    // Remember the latest one (kept across reloads, since a grid can sit filled for a while).
    const before = lastCounts.get(player.id);
    if (before) {
        for (const [id, n] of before) {
            if ((counts.get(id) ?? 0) < n) player.setDynamicProperty(LAST_TAKEN_KEY, id);
        }
    }
    lastCounts.set(player.id, counts);
    // Freshly crafted copies become that design. (Until one is known they wait as they are.)
    if (copies.length === 0) return;
    const raw = player.getDynamicProperty(LAST_TAKEN_KEY);
    const id = typeof raw === "number" ? raw : 0;
    if (!id) return;
    for (const slot of copies) {
        const item = container.getItem(slot);
        if (item) container.setItem(slot, designItem(id, item.amount));
    }
    player.onScreenDisplay.setActionBar(`Copied component #${id}`);
}

system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        try {
            trackInventory(player);
        } catch (e) {
            if (!trackerFailed) world.sendMessage(`§c[blueprint] Inventory scan failed: ${e}`);
            trackerFailed = true;
        }
    }
}, 5);

// Which design each player is about to place, read from the item before it's placed.
const pendingPlace = new Map(); // player id -> design id

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const item = event.itemStack;
    if (item?.typeId !== COMPONENT) return;
    pendingPlace.set(event.player.id, designFromItem(item));
});

world.afterEvents.playerPlaceBlock.subscribe(({ block, player }) => {
    if (block.typeId !== COMPONENT) return;
    const id = pendingPlace.get(player.id) ?? 0;
    pendingPlace.delete(player.id);
    bindInstance(block, id);
});

// Breaking a component drops an item that carries its design. (The block's own loot is
// empty so there's no second, blank drop.) In creative, only blocks with a design drop.
world.afterEvents.playerBreakBlock.subscribe(({ block, brokenBlockPermutation, player }) => {
    if (brokenBlockPermutation.type.id !== COMPONENT) return;
    const id = designIdOf(block);
    forgetInstance(block.dimension.id, block.location);
    if (player.getGameMode() === GameMode.Creative && !id) return;
    const { x, y, z } = block.location;
    block.dimension.spawnItem(designItem(id), { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
});
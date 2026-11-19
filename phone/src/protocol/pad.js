// @ts-check
// Gamepad state in XInput's own layout, so the PC copies it straight into the virtual controller.

/** XInput button bits. */
export const BUTTON = Object.freeze({
  UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008,
  START: 0x0010, BACK: 0x0020, L3: 0x0040, R3: 0x0080,
  LB: 0x0100, RB: 0x0200, A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
});
export const DPAD = BUTTON.UP | BUTTON.DOWN | BUTTON.LEFT | BUTTON.RIGHT;

/**
 * Triggers are 0..255, stick axes -32767..32767 with +y up.
 * @typedef {{ buttons: number, lt: number, rt: number, lx: number, ly: number, rx: number, ry: number }} Pad
 */

/** @returns {Pad} */
export const neutralPad = () => ({ buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });

/** Stick axis from -1..1. @param {number} v */
export const axis = v => Math.round(Math.max(-1, Math.min(1, v)) * 32767);

/** Trigger from 0..1. @param {number} v */
export const trigger = v => Math.round(Math.max(0, Math.min(1, v)) * 255);

/**
 * One state packet, little-endian: seq u16, buttons u16, LT u8, RT u8, LX LY RX RY i16.
 * Delivery is unordered, so the PC drops any packet older than the last seq it applied.
 * @param {Pad} pad
 * @param {number} seq
 */
export function encode(pad, seq) {
  const v = new DataView(new ArrayBuffer(14));
  v.setUint16(0, seq & 0xffff, true);
  v.setUint16(2, pad.buttons, true);
  v.setUint8(4, pad.lt);
  v.setUint8(5, pad.rt);
  v.setInt16(6, pad.lx, true);
  v.setInt16(8, pad.ly, true);
  v.setInt16(10, pad.rx, true);
  v.setInt16(12, pad.ry, true);
  return v.buffer;
}

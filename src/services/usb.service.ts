/**
 * ViableUSB / VialUSB - USB HID communication layer for Vial-compatible keyboards
 *
 * Protocol: Standard QMK-VIA / Vial raw HID
 *   Request:  [cmd][args...]          (32 bytes, zero-padded)
 *   Response: [cmd_echo][data...]     (cmd echoed in byte 0)
 *
 * NOTE: The 0xFE "prefix" is NOT sent as a separate byte. In QMK's
 * raw_hid_receive(), the first byte of the report IS the command ID.
 * Some Vial GUI tools prepend 0xFE as a host-side framing convention, but
 * QMK-VIA firmware expects: report[0] = command_id.
 */

import type { USBSendOptions } from "../types/vial.types";
import { MSG_LEN } from "./utils";

// ---- VIA command IDs (QMK-VIA standard) ----
const CMD_VIA_GET_PROTOCOL_VERSION = 0x01;
const CMD_VIA_GET_KEYBOARD_VALUE = 0x02;
const CMD_VIA_SET_KEYBOARD_VALUE = 0x03;
const CMD_VIA_GET_KEYCODE = 0x04;
const CMD_VIA_SET_KEYCODE = 0x05;
const CMD_VIA_LIGHTING_SET_VALUE = 0x07;
const CMD_VIA_LIGHTING_GET_VALUE = 0x08;
const CMD_VIA_LIGHTING_SAVE = 0x09;
const CMD_VIA_MACRO_GET_COUNT = 0x0c;
const CMD_VIA_MACRO_GET_BUFFER_SIZE = 0x0d;
const CMD_VIA_MACRO_GET_BUFFER = 0x0e;
const CMD_VIA_MACRO_SET_BUFFER = 0x0f;
const CMD_VIA_GET_LAYER_COUNT = 0x11;
const CMD_VIA_KEYMAP_GET_BUFFER = 0x12;

// VIA "keyboard value" IDs
const VIA_VALUE_LAYOUT_OPTIONS = 0x02;
const VIA_VALUE_SWITCH_MATRIX_STATE = 0x03;

// QMK lighting value IDs (channel 1 = backlight, 2 = rgblight)
const QMK_BACKLIGHT_BRIGHTNESS = 0x09;
const QMK_BACKLIGHT_EFFECT = 0x0a;
const QMK_RGBLIGHT_BRIGHTNESS = 0x80;
const QMK_RGBLIGHT_EFFECT = 0x81;
const QMK_RGBLIGHT_EFFECT_SPEED = 0x82;
const QMK_RGBLIGHT_COLOR = 0x83;

// VialRGB (sub-commands sent via VIA "get/set keyboard value" or as raw Vial)
const VIALRGB_GET_INFO = 0x40;
const VIALRGB_GET_MODE = 0x41;
const VIALRGB_GET_SUPPORTED = 0x42;
const VIALRGB_SET_MODE = 0x41;

// Layer color (channel 0, value_id 32..47)
const LAYER_COLOR_CHANNEL = 0;
const LAYER_COLOR_VALUE_ID_BASE = 32;

export class VialUSB {
  private device?: HIDDevice;
  private queue: Promise<void> = Promise.resolve();
  private listener: (data: ArrayBuffer, ev: HIDInputReportEvent) => void = () => {};

  public onDisconnect?: () => void;
  static DEBUG = false;

  // ---- public constants (kept for service-layer compatibility) ----
  static readonly CMD_VIA_GET_PROTOCOL_VERSION = CMD_VIA_GET_PROTOCOL_VERSION;
  static readonly CMD_VIA_GET_KEYBOARD_VALUE = CMD_VIA_GET_KEYBOARD_VALUE;
  static readonly CMD_VIA_SET_KEYBOARD_VALUE = CMD_VIA_SET_KEYBOARD_VALUE;
  static readonly CMD_VIA_GET_KEYCODE = CMD_VIA_GET_KEYCODE;
  static readonly CMD_VIA_SET_KEYCODE = CMD_VIA_SET_KEYCODE;
  static readonly CMD_VIA_LIGHTING_SET_VALUE = CMD_VIA_LIGHTING_SET_VALUE;
  static readonly CMD_VIA_LIGHTING_GET_VALUE = CMD_VIA_LIGHTING_GET_VALUE;
  static readonly CMD_VIA_LIGHTING_SAVE = CMD_VIA_LIGHTING_SAVE;
  static readonly CMD_VIA_MACRO_GET_COUNT = CMD_VIA_MACRO_GET_COUNT;
  static readonly CMD_VIA_MACRO_GET_BUFFER_SIZE = CMD_VIA_MACRO_GET_BUFFER_SIZE;
  static readonly CMD_VIA_MACRO_GET_BUFFER = CMD_VIA_MACRO_GET_BUFFER;
  static readonly CMD_VIA_MACRO_SET_BUFFER = CMD_VIA_MACRO_SET_BUFFER;
  static readonly CMD_VIA_GET_LAYER_COUNT = CMD_VIA_GET_LAYER_COUNT;
  static readonly CMD_VIA_KEYMAP_GET_BUFFER = CMD_VIA_KEYMAP_GET_BUFFER;

  static readonly VIA_LAYOUT_OPTIONS = VIA_VALUE_LAYOUT_OPTIONS;
  static readonly VIA_SWITCH_MATRIX_STATE = VIA_VALUE_SWITCH_MATRIX_STATE;

  static readonly QMK_BACKLIGHT_BRIGHTNESS = QMK_BACKLIGHT_BRIGHTNESS;
  static readonly QMK_BACKLIGHT_EFFECT = QMK_BACKLIGHT_EFFECT;
  static readonly QMK_RGBLIGHT_BRIGHTNESS = QMK_RGBLIGHT_BRIGHTNESS;
  static readonly QMK_RGBLIGHT_EFFECT = QMK_RGBLIGHT_EFFECT;
  static readonly QMK_RGBLIGHT_EFFECT_SPEED = QMK_RGBLIGHT_EFFECT_SPEED;
  static readonly QMK_RGBLIGHT_COLOR = QMK_RGBLIGHT_COLOR;

  static readonly VIALRGB_GET_INFO = VIALRGB_GET_INFO;
  static readonly VIALRGB_GET_MODE = VIALRGB_GET_MODE;
  static readonly VIALRGB_GET_SUPPORTED = VIALRGB_GET_SUPPORTED;
  static readonly VIALRGB_SET_MODE = VIALRGB_SET_MODE;

  // Viable-only command IDs (kept as constants so service files compile;
  // sendViable() will throw at runtime if actually invoked)
  static readonly CMD_VIABLE_GET_INFO = 0x00;
  static readonly CMD_VIABLE_TAP_DANCE_GET = 0x01;
  static readonly CMD_VIABLE_TAP_DANCE_SET = 0x02;
  static readonly CMD_VIABLE_COMBO_GET = 0x03;
  static readonly CMD_VIABLE_COMBO_SET = 0x04;
  static readonly CMD_VIABLE_KEY_OVERRIDE_GET = 0x05;
  static readonly CMD_VIABLE_KEY_OVERRIDE_SET = 0x06;
  static readonly CMD_VIABLE_ALT_REPEAT_KEY_GET = 0x07;
  static readonly CMD_VIABLE_ALT_REPEAT_KEY_SET = 0x08;
  static readonly CMD_VIABLE_ONE_SHOT_GET = 0x09;
  static readonly CMD_VIABLE_ONE_SHOT_SET = 0x0a;
  static readonly CMD_VIABLE_SAVE = 0x0b;
  static readonly CMD_VIABLE_RESET = 0x0c;
  static readonly CMD_VIABLE_DEFINITION_SIZE = 0x0d;
  static readonly CMD_VIABLE_DEFINITION_CHUNK = 0x0e;
  static readonly CMD_VIABLE_QMK_SETTINGS_QUERY = 0x10;
  static readonly CMD_VIABLE_QMK_SETTINGS_GET = 0x11;
  static readonly CMD_VIABLE_QMK_SETTINGS_SET = 0x12;
  static readonly CMD_VIABLE_QMK_SETTINGS_RESET = 0x13;
  static readonly CMD_VIABLE_LEADER_GET = 0x14;
  static readonly CMD_VIABLE_LEADER_SET = 0x15;
  static readonly CMD_VIABLE_LAYER_STATE_GET = 0x16;
  static readonly CMD_VIABLE_LAYER_STATE_SET = 0x17;
  static readonly CMD_VIABLE_FRAGMENT_GET_HARDWARE = 0x18;
  static readonly CMD_VIABLE_FRAGMENT_GET_SELECTIONS = 0x19;
  static readonly CMD_VIABLE_FRAGMENT_SET_SELECTIONS = 0x1a;

  static readonly VIABLE_UNSUPPORTED_MSG =
    "Viable-only command invoked on a Vial/VIA-only build. " +
    "This keyboard does not expose the 0xDF Viable protocol.";

  // ---- connection lifecycle ----
  private handleDisconnect = (event: HIDConnectionEvent) => {
    if (this.device && event.device === this.device) {
      console.log("Device disconnected:", event.device.productName);
      if (this.onDisconnect) this.onDisconnect();
      this.close();
    }
  };

  async open(filters: HIDDeviceFilter[]): Promise<boolean> {
    const devices = await navigator.hid.requestDevice({ filters });
    if (devices.length !== 1) return false;
    this.device = devices[0];
    if (!this.device.opened) await this.device.open();
    await this.initListener();
    navigator.hid.addEventListener("disconnect", this.handleDisconnect);
    console.log("USB device opened:", this.device.productName);
    return true;
  }

  getDeviceName(): string | null {
    return this.device?.productName || null;
  }

  async close(): Promise<void> {
    if (this.handleEvent) {
      this.device?.removeEventListener("inputreport", this.handleEvent);
      this.handleEvent = undefined;
    }
    if (this.device) {
      await this.device.close();
      this.device = undefined;
    }
    navigator.hid.removeEventListener("disconnect", this.handleDisconnect);
  }

  private handleEvent?: (ev: HIDInputReportEvent) => void;

  private async initListener(): Promise<void> {
    if (!this.device) return;
    const handleEvent = (ev: HIDInputReportEvent) => {
      if (this.listener) {
        this.listener(ev.data.buffer as ArrayBuffer, ev);
      }
    };
    this.handleEvent = handleEvent;
    this.device.addEventListener("inputreport", handleEvent);
  }

  // ---- message building ----
  /**
   * Build a 32-byte HID report for QMK-VIA / Vial.
   *   report[0] = command ID
   *   report[1..] = arguments
   *   remainder  = zero (already zero from Uint8Array constructor)
   */
  private buildMessage(cmd: number, args: number[]): Uint8Array {
    const msg = new Uint8Array(MSG_LEN);
    msg[0] = cmd;
    for (let i = 0; i < args.length && i < MSG_LEN - 1; i++) {
      msg[1 + i] = args[i];
    }
    if (VialUSB.DEBUG) {
      const hex = Array.from(msg.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(`[VIA] TX cmd=0x${cmd.toString(16)} : ${hex}`);
    }
    return msg;
  }

  // ---- public send ----
  async send(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array> {
    if (!this.device) throw new Error("USB device not connected");

    const message = this.buildMessage(cmd, args);

    const operation = this.queue.then(
      () =>
        new Promise<Uint8Array>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            console.warn(
              "USB Command Timed out waiting for valid response:",
              cmd
            );
            reject(new Error("USB Command Timeout"));
          }, 1000);

          this.listener = (data: ArrayBuffer) => {
            const u8 = new Uint8Array(data);

            // QMK-VIA echo rule: report[0] is the command ID echoed back.
            if (u8[0] !== cmd) return;

            if (options.validateInput) {
              if (!options.validateInput(u8)) return;
            }

            if (VialUSB.DEBUG) {
              const hex = Array.from(u8.slice(0, 8))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(" ");
              console.log(`[VIA] RX cmd=0x${cmd.toString(16)} : ${hex}`);
            }

            clearTimeout(timeoutId);
            try {
              const result = this.parseResponse(data, options);
              resolve(result as Uint8Array);
            } catch (e) {
              reject(e);
            }
          };

          this.device!.sendReport(0, message as BufferSource).catch((err: unknown) => {
            clearTimeout(timeoutId);
            reject(err);
          });
        })
    );

    this.queue = operation.then(() => undefined).catch(() => undefined);
    return operation;
  }

  /**
   * sendViable: Viable-only commands (0xDF protocol) are NOT supported by
   * standard QMK-VIA / Vial firmware. This stub exists so service files that
   * reference usb.sendViable(...) continue to compile. At runtime it throws
   * a clear error if a Viable-only feature is actually triggered.
   */
  async sendViable(
    cmd: number,
    args: number[],
    _options: USBSendOptions = {}
  ): Promise<never> {
    console.warn(
      `sendViable called (cmd=0x${cmd.toString(16)}, args=${JSON.stringify(args)})`
    );
    throw new Error(VialUSB.VIABLE_UNSUPPORTED_MSG);
  }

  // ---- response parsing ----
  private parseResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array {
    const skipBytes = options.skipBytes || 0;
    const u8 = new Uint8Array(data);

    if (options.uint8) {
      const sliced = skipBytes > 0 ? u8.slice(skipBytes) : u8;
      return sliced;
    }

    // default: return raw bytes after skipBytes
    return skipBytes > 0 ? u8.slice(skipBytes) : u8;
  }

  // ---- buffered transfer (VIA 22-byte chunks) ----
  async getViaBuffer(
    cmd: number,
    size: number,
    options: USBSendOptions = {}
  ): Promise<Uint8Array> {
    const chunksize = 22; // VIA payload per report
    const alldata: number[] = [];
    let offset = 0;

    while (offset < size) {
      const sz = Math.min(chunksize, size - offset);
      // VIA offset is big-endian 16-bit
      const args = [
        (offset >> 8) & 0xff,
        offset & 0xff,
        sz,
      ];
      const data = (await this.send(cmd, args, options)) as unknown as Uint8Array;
      for (let i = 0; i < data.length; i++) alldata.push(data[i]);
      offset += sz;
    }

    return new Uint8Array(alldata);
  }

  async pushViaBuffer(
    cmd: number,
    size: number,
    data: ArrayBuffer
  ): Promise<void> {
    const buffer = new Uint8Array(data);
    const chunkSize = 22;
    let offset = 0;
    let chunkOffset = 0;

    while (offset < size) {
      const chunk = new Uint8Array(chunkSize);
      for (let i = 0; i < chunk.length && offset < size; i++) {
        chunk[i] = buffer[offset++];
      }
      await this.send(cmd, [
        chunkOffset & 0xff,
        (chunkOffset >> 8) & 0xff,
        ...Array.from(chunk),
      ], {});
      chunkOffset += chunk.length;
    }
  }

  // ---- Viable definition (not supported in VIA-only build) ----
  async getViableDefinition(): Promise<Uint8Array> {
    throw new Error(VialUSB.VIABLE_UNSUPPORTED_MSG);
  }

  // ---- custom value protocol (0x07 / 0x08 / 0x09) ----
  async customValueGet(
    channel: number,
    valueId: number,
    size: number = 2
  ): Promise<Uint8Array> {
    const resp = (await this.send(
      CMD_VIA_LIGHTING_GET_VALUE,
      [channel, valueId],
      {
        uint8: true,
        skipBytes: 3, // skip cmd_echo + channel + value_id
        validateInput: (u) =>
          u[0] === CMD_VIA_LIGHTING_GET_VALUE &&
          u[1] === channel &&
          u[2] === valueId,
      }
    )) as unknown as Uint8Array;
    return resp.slice(0, size);
  }

  async customValueSet(
    channel: number,
    valueId: number,
    data: number[]
  ): Promise<void> {
    console.log(
      `customValueSet: channel=${channel}, valueId=${valueId}, data=[${data.join(", ")}]`
    );
    await this.send(
      CMD_VIA_LIGHTING_SET_VALUE,
      [channel, valueId, ...data],
      {}
    );
  }

  async customValueSave(channel: number): Promise<void> {
    await this.send(CMD_VIA_LIGHTING_SAVE, [channel], {});
  }

  // ---- layer color helpers (channel 0, value_id 32..47) ----
  async getLayerColor(
    layer: number
  ): Promise<{ hue: number; sat: number }> {
    const valueId = LAYER_COLOR_VALUE_ID_BASE + layer;
    const data = await this.customValueGet(LAYER_COLOR_CHANNEL, valueId, 2);
    return { hue: data[0], sat: data[1] };
  }

  async setLayerColor(
    layer: number,
    hue: number,
    sat: number
  ): Promise<void> {
    const valueId = LAYER_COLOR_VALUE_ID_BASE + layer;
    console.log(
      `setLayerColor: layer=${layer}, valueId=${valueId}, hue=${hue}, sat=${sat}`
    );
    await this.customValueSet(LAYER_COLOR_CHANNEL, valueId, [hue, sat]);
    await this.customValueSave(LAYER_COLOR_CHANNEL);
  }

  async getAllLayerColors(): Promise<Array<{ hue: number; sat: number }>> {
    const colors: Array<{ hue: number; sat: number }> = [];
    for (let i = 0; i < 16; i++) {
      try {
        colors.push(await this.getLayerColor(i));
      } catch {
        colors.push({ hue: 0, sat: 0 });
      }
    }
    return colors;
  }
}

// ---- exports ----
export const usbInstance = new VialUSB();
export { VialUSB as ViableUSB };

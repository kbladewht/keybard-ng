// USB HID communication layer — Vial (QMK-VIA) only
// Speaks the raw VIA protocol: [0xFE][cmd][args...] / response [0xFE][cmd][data...]
// No 0xDD client-id wrapper, no bootstrap, no Viable-specific commands.
import type { USBSendOptions } from "../types/vial.types";
import { MSG_LEN } from "./utils";

const VIA_PREFIX = 0xfe;


export class VialUSB {
  // VIA command constants
  static readonly CMD_VIA_GET_PROTOCOL_VERSION = 0x01;
  static readonly CMD_VIA_GET_KEYBOARD_VALUE = 0x02;
  static readonly CMD_VIA_SET_KEYBOARD_VALUE = 0x03;
  static readonly CMD_VIA_GET_KEYCODE = 0x04;
  static readonly CMD_VIA_SET_KEYCODE = 0x05;
  static readonly CMD_VIA_LIGHTING_SET_VALUE = 0x07;
  static readonly CMD_VIA_LIGHTING_GET_VALUE = 0x08;
  static readonly CMD_VIA_LIGHTING_SAVE = 0x09;
  static readonly CMD_VIA_MACRO_GET_COUNT = 0x0c;
  static readonly CMD_VIA_MACRO_GET_BUFFER_SIZE = 0x0d;
  static readonly CMD_VIA_MACRO_GET_BUFFER = 0x0e;
  static readonly CMD_VIA_MACRO_SET_BUFFER = 0x0f;
  static readonly CMD_VIA_GET_LAYER_COUNT = 0x11;
  static readonly CMD_VIA_KEYMAP_GET_BUFFER = 0x12;

  static readonly VIA_LAYOUT_OPTIONS = 0x02;
  static readonly VIA_SWITCH_MATRIX_STATE = 0x03;

  static readonly QMK_BACKLIGHT_BRIGHTNESS = 0x09;
  static readonly QMK_BACKLIGHT_EFFECT = 0x0a;
  static readonly QMK_RGBLIGHT_BRIGHTNESS = 0x80;
  static readonly QMK_RGBLIGHT_EFFECT = 0x81;
  static readonly QMK_RGBLIGHT_EFFECT_SPEED = 0x82;
  static readonly QMK_RGBLIGHT_COLOR = 0x83;

  // Vial (VIALRGB) command constants
  static readonly VIALRGB_GET_INFO = 0x40;
  static readonly VIALRGB_GET_MODE = 0x41;
  static readonly VIALRGB_GET_SUPPORTED = 0x42;
  static readonly VIALRGB_SET_MODE = 0x41;

  // ---- Viable-only command constants (kept for service-layer compile compatibility) ----
  // These commands are NOT part of standard VIA/Vial. They are emitted by Viable
  // firmware behind a 0xDD wrapper, which this Vial-only build does not support.
  // Calling sendViable() at runtime will throw a clear error.
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

  private device?: HIDDevice;
  private queue: Promise<void> = Promise.resolve();
  private listener: (data: ArrayBuffer, ev: HIDInputReportEvent) => void = () => {};

  public onDisconnect?: () => void;

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
    if (!this.device.opened) {
      await this.device.open();
    }
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

  // ---- raw message building ------------------------------------------------

  /**
   * Build a raw VIA message: [0xFE][cmd][args...], zero-padded to MSG_LEN.
   */
  private buildMessage(cmd: number, args: number[]): Uint8Array {
    const message = new Uint8Array(MSG_LEN);
    message[0] = VIA_PREFIX;
    message[1] = cmd;
    for (let i = 0; i < args.length && i < MSG_LEN - 2; i++) {
      message[2 + i] = args[i];
    }
    return message;
  }

  // ---- send / response parsing --------------------------------------------

  // Overload signatures
  async send(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index: number }): Promise<number | bigint>;
  async send(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[]>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index: number }): Promise<number>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index: number }): Promise<number>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index: number }): Promise<number>;
  async send(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array>;
  async send(cmd: number, args: number[], options?: USBSendOptions): Promise<Uint8Array>;

  /**
   * Send a VIA command and await the matching response.
   * Response must start with [0xFE][cmd] (echoed command byte).
   */
  async send(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]> {
    if (!this.device) throw new Error("USB device not connected");

    const message = this.buildMessage(cmd, args);

    const operation = this.queue.then(async () => {
      return new Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          console.warn("USB Command Timed out waiting for valid response:", cmd);
          reject(new Error("USB Command Timeout"));
        }, 1000);

        this.listener = (data: ArrayBuffer) => {
          const u8 = new Uint8Array(data);

          // Must be a VIA response and echo the command we sent.
          if (u8[0] !== VIA_PREFIX) return;
          if (u8[1] !== cmd) return;

          if (options.validateInput) {
            if (!options.validateInput(u8)) return;
          }

          clearTimeout(timeoutId);
          try {
            const result = this.parseResponse(data, options);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        };

        this.device!.sendReport(0, message as BufferSource).catch(err => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });
    });

    this.queue = operation.then(() => undefined).catch(() => undefined);
    return operation;
  }

  // ---- sendViable (compile-compatible stub) ---------------------------------
  // Viable-only commands (Tap Dance / Combo / Key Override / QMK Settings /
  // Fragment / Alt-Repeat / Leader / One-Shot / Viable Definition / Save /
  // Reset) are NOT part of standard VIA/Vial. This build is Vial-only, so we
  // keep the API surface so existing services compile, but invoking it at
  // runtime throws a clear, actionable error instead of silently misbehaving.

  static get VIABLE_UNSUPPORTED_MSG(): string {
    return (
      "Viable-only command called on a Vial-only build. " +
      "Tap Dance / Combo / Key Override / QMK Settings / Fragment / " +
      "Alt-Repeat / Leader / One-Shot / Viable Definition / Save / Reset " +
      "require Viable firmware and are not supported here."
    );
  }

  async sendViable(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index: number }): Promise<number | bigint>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[]>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index: number }): Promise<number>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index: number }): Promise<number>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index: number }): Promise<number>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array>;
  async sendViable(cmd: number, args: number[], options?: USBSendOptions): Promise<Uint8Array>;
  async sendViable(cmd: number, args: number[], _options: USBSendOptions = {}): Promise<never> {
    void cmd; void args;
    throw new Error(VialUSB.VIABLE_UNSUPPORTED_MSG);
  }

  // ---- response parsing ----------------------------------------------------

  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { unpack: string; index: number }): number | bigint;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { unpack: string; index?: undefined }): (number | bigint)[];
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint8: true; index: number }): number;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint8: true; index?: undefined }): Uint8Array;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint16: true; index: number }): number;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint16: true; index?: undefined }): Uint16Array;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint32: true; index: number }): number;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions & { uint32: true; index?: undefined }): Uint32Array;
  private parseResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array;

  private parseResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[] {
    const skipBytes = options.skipBytes || 0;
    const dv = new DataView(data);
    const u8 = new Uint8Array(data);

    if (options.unpack) {
      const offsetDv = skipBytes > 0 ? new DataView(data, skipBytes) : dv;
      const unpacked = this.unpackData(offsetDv, options.unpack);
      if (options.index !== undefined) {
        return unpacked[options.index];
      }
      return unpacked;
    }

    if (options.uint8) {
      if (options.index !== undefined) {
        return u8[skipBytes + options.index];
      }
      return skipBytes > 0 ? u8.slice(skipBytes) : u8;
    }

    if (options.uint16) {
      const littleEndian = !options.bigendian;
      if (options.index !== undefined) {
        return dv.getUint16(skipBytes + options.index, littleEndian);
      }
      const numValues = Math.floor((data.byteLength - skipBytes) / 2);
      const values: number[] = [];
      for (let i = 0; i < numValues; i++) {
        values.push(dv.getUint16(skipBytes + i * 2, littleEndian));
      }
      let u16Array = new Uint16Array(values);
      if (options.slice !== undefined) {
        u16Array = u16Array.slice(options.slice);
      }
      return u16Array;
    }

    if (options.uint32) {
      const littleEndian = !options.bigendian;
      if (options.index !== undefined) {
        return dv.getUint32(skipBytes + options.index, littleEndian);
      }
      const numValues = Math.floor((data.byteLength - skipBytes) / 4);
      const values: number[] = [];
      for (let i = 0; i < numValues; i++) {
        values.push(dv.getUint32(skipBytes + i * 4, littleEndian));
      }
      return new Uint32Array(values);
    }

    return skipBytes > 0 ? u8.slice(skipBytes) : u8;
  }

  private unpackData(dv: DataView, format: string): (number | bigint)[] {
    const results: (number | bigint)[] = [];
    let offset = 0;
    let littleEndian = true;

    if (format.includes("<")) littleEndian = true;
    if (format.includes(">")) littleEndian = false;

    const formatChars = format.replace(/[<>]/g, "");

    for (const char of formatChars) {
      switch (char) {
        case "B":
          results.push(dv.getUint8(offset));
          offset += 1;
          break;
        case "H":
          results.push(dv.getUint16(offset, littleEndian));
          offset += 2;
          break;
        case "I":
          results.push(dv.getUint32(offset, littleEndian));
          offset += 4;
          break;
        case "Q":
          results.push(dv.getBigUint64(offset, littleEndian));
          offset += 8;
          break;
      }
    }

    return results;
  }

  // ---- buffered transfer helpers ------------------------------------------

  /**
   * Read `size` bytes from a VIA buffered-get command in 22-byte chunks.
   * VIA payload per report = 32 - 2 (VIA header) = 30, but keymap/getkeycode
   * uses a 2-byte offset header, so chunk payload is 22 bytes of useful data.
   */
  async getViaBuffer(
    cmd: number,
    size: number,
    options: USBSendOptions = {},
    checkComplete?: (data: number[] | Uint8Array) => boolean
  ): Promise<number[] | Uint8Array> {
    const chunksize = 22;
    const bytes = options.bytes || 1;
    const alldata: number[] = [];
    let offset = 0;

    while (offset < size) {
      let sz = chunksize;
      if (sz > size - offset) {
        sz = size - offset;
      }

      // BE16(offset) = two bytes, big-endian offset, then size
      const args = [((offset >> 8) & 0xff), (offset & 0xff), sz];
      const data = (await this.send(cmd, args, options)) as unknown as Uint8Array;

      if (sz < chunksize) {
        const sliceSize = Math.floor(sz / bytes);
        alldata.push(...Array.from(data).slice(0, sliceSize));
      } else {
        alldata.push(...Array.from(data));
      }

      if (checkComplete && checkComplete(alldata)) {
        break;
      }

      offset += chunksize;
    }

    if (options.uint16) {
      return alldata;
    }

    return new Uint8Array(alldata);
  }

  async pushViaBuffer(cmd: number, size: number, data: ArrayBuffer): Promise<void> {
    const buffer = new Uint8Array(data);
    let offset = 0;
    let chunkOffset = 0;
    const chunkSize = 22;

    while (offset < size) {
      const chunk = new Uint8Array(chunkSize);
      for (let i = 0; i < chunk.length && offset < size; i++) {
        chunk[i] = buffer[offset++];
      }

      await this.send(cmd, [chunkOffset & 0xff, (chunkOffset >> 8) & 0xff, ...chunk], {});
      chunkOffset += chunk.length;
    }
  }

  // ---- VIA Custom Value Protocol (0x07/0x08/0x09) -------------------------
  // Channels: 0 = keyboard-specific, 1 = QMK backlight, 2 = QMK rgblight

  /**
   * Get a custom value.
   * Request: [0xFE][0x08][channel][value_id]
   * Response: [0xFE][0x08][channel][value_id][data...]
   */
  async customValueGet(channel: number, valueId: number, size: number = 2): Promise<Uint8Array> {
    const resp = await this.send(
      VialUSB.CMD_VIA_LIGHTING_GET_VALUE,
      [channel, valueId],
      {
        uint8: true,
        skipBytes: 3, // skip cmd_echo, channel, value_id
        validateInput: (u: Uint8Array) =>
          u[0] === VialUSB.CMD_VIA_LIGHTING_GET_VALUE &&
          u[1] === channel &&
          u[2] === valueId,
      }
    );
    return (resp as unknown as Uint8Array).slice(0, size);
  }

  /**
   * Set a custom value.
   * Request: [0xFE][0x07][channel][value_id][data...]
   */
  async customValueSet(channel: number, valueId: number, data: number[]): Promise<void> {
    console.log(`customValueSet: channel=${channel}, valueId=${valueId}, data=[${data.join(", ")}]`);
    await this.send(
      VialUSB.CMD_VIA_LIGHTING_SET_VALUE,
      [channel, valueId, ...data],
      {}
    );
  }

  /**
   * Save custom values to EEPROM.
   * Request: [0xFE][0x09][channel]
   */
  async customValueSave(channel: number): Promise<void> {
    await this.send(VialUSB.CMD_VIA_LIGHTING_SAVE, [channel], {});
  }

  // ---- Layer Color convenience (channel 0, value_ids 32-47) ---------------
  // Color format: 2 bytes [hue, sat] (0-255, QMK HSV)

  static readonly LAYER_COLOR_VALUE_ID_BASE = 32;
  static readonly LAYER_COLOR_CHANNEL = 0;

  async getLayerColor(layer: number): Promise<{ hue: number; sat: number }> {
    const valueId = VialUSB.LAYER_COLOR_VALUE_ID_BASE + layer;
    const data = await this.customValueGet(VialUSB.LAYER_COLOR_CHANNEL, valueId, 2);
    return { hue: data[0], sat: data[1] };
  }

  async setLayerColor(layer: number, hue: number, sat: number): Promise<void> {
    const valueId = VialUSB.LAYER_COLOR_VALUE_ID_BASE + layer;
    console.log(`setLayerColor: layer=${layer}, valueId=${valueId}, hue=${hue}, sat=${sat}`);
    await this.customValueSet(VialUSB.LAYER_COLOR_CHANNEL, valueId, [hue, sat]);
    await this.customValueSave(VialUSB.LAYER_COLOR_CHANNEL);
  }

  async getAllLayerColors(): Promise<Array<{ hue: number; sat: number }>> {
    const colors: Array<{ hue: number; sat: number }> = [];
    for (let i = 0; i < 16; i++) {
      try {
        const color = await this.getLayerColor(i);
        colors.push(color);
      } catch {
        colors.push({ hue: 0, sat: 0 });
      }
    }
    return colors;
  }
}

// Export singleton instance (recommended: create a fresh instance per connection)
export const usbInstance = new VialUSB();

// Backward-compatibility alias for existing imports
export { VialUSB as ViableUSB };

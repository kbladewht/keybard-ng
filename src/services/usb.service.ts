// USB HID communication layer for Viable protocol
// Supports client ID wrapper (0xDD) for multi-client concurrent access
import type { USBSendOptions } from "../types/vial.types";
import { BE16, LE16, MSG_LEN } from "./utils";

// Protocol prefixes
const WRAPPER_PREFIX = 0xdd;
const VIABLE_PREFIX = 0xdf;
const VIA_PREFIX = 0xfe;

// Client ID constants
const NONCE_SIZE = 20;
const DEFAULT_TTL_SECS = 120;

// Generate cryptographically random nonce
function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return nonce;
}

export class ViableUSB {
  // VIA command constants (unchanged, used via wrapper)
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

  static readonly VIALRGB_GET_INFO = 0x40;
  static readonly VIALRGB_GET_MODE = 0x41;
  static readonly VIALRGB_GET_SUPPORTED = 0x42;
  static readonly VIALRGB_SET_MODE = 0x41;

  // Viable command IDs (0xDF protocol)
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

  // Svalboard-specific constants
  static readonly SVAL_GET_LEFT_DPI = 0x00;
  static readonly SVAL_GET_RIGHT_DPI = 0x00;
  static readonly SVAL_GET_LEFT_SCROLL = 0x00;
  static readonly SVAL_GET_RIGHT_SCROLL = 0x00;
  static readonly SVAL_GET_AUTOMOUSE = 0x00;
  static readonly SVAL_GET_AUTOMOUSE_MS = 0x00;

  static readonly SVAL_SET_LEFT_DPI = 0x00;
  static readonly SVAL_SET_RIGHT_DPI = 0x00;
  static readonly SVAL_SET_LEFT_SCROLL = 0x00;
  static readonly SVAL_SET_RIGHT_SCROLL = 0x00;
  static readonly SVAL_SET_AUTOMOUSE = 0x00;
  static readonly SVAL_SET_AUTOMOUSE_MS = 0x00;

  private device?: HIDDevice;
  private queue: Promise<void> = Promise.resolve();
  private listener: (data: ArrayBuffer, ev: HIDInputReportEvent) => void =
    () => { };

  // Client ID management
  private clientId: number = 0;
  private clientTtl: number = DEFAULT_TTL_SECS;
  private clientIdExpiry: number = 0;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private bootstrapPromise?: Promise<void>; // Prevent concurrent bootstraps

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

    // Don't bootstrap here - do it lazily on first command
    // This helps debug connection issues
    console.log("USB device opened:", this.device.productName);

    return true;
  }

  /**
   * Check if the device is a Viable keyboard by checking serial number
   * TODO: Implement proper detection by checking "viable:" prefix in USB serial
   */
  isViableDevice(): boolean {
    // For now, assume viable if connected
    // Real detection would check USB serial string for "viable:" prefix
    return true;
  }

  /**
   * Ensure we have a valid client ID, bootstrapping if needed
   */
  private async ensureClientId(): Promise<void> {
    // If bootstrap already in progress, wait for it
    if (this.bootstrapPromise) {
      await this.bootstrapPromise;
      return;
    }

    if (this.clientId === 0 || Date.now() >= this.clientIdExpiry) {
      console.log("Bootstrapping client ID...");
      this.bootstrapPromise = this.bootstrapClientId();
      try {
        await this.bootstrapPromise;
      } finally {
        this.bootstrapPromise = undefined;
      }
    }
  }

  /**
   * Bootstrap a client ID from the keyboard
   * Request: [0xDD][0x00000000][nonce:20]
   * Response: [0xDD][0x00000000][nonce:20][new_client_id:4][ttl:2]
   */
  private async bootstrapClientId(): Promise<void> {
    if (!this.device) throw new Error("USB device not connected");

    const nonce = generateNonce();

    const message = new Uint8Array(MSG_LEN);
    message[0] = WRAPPER_PREFIX;
    // Client ID = 0 (bootstrap)
    message[1] = 0;
    message[2] = 0;
    message[3] = 0;
    message[4] = 0;
    // Nonce
    message.set(nonce, 5);

    console.log("Bootstrap request:", Array.from(message.slice(0, 30)).map(b => b.toString(16).padStart(2, '0')).join(' '));

    // Send bootstrap request and wait for OUR response (might get other clients' responses first)
    const maxAttempts = 5;
    const maxReadsPerAttempt = 50;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Send the bootstrap request
      await this.device!.sendReport(0, message as BufferSource);

      // Read responses until we find ours or timeout
      for (let read = 0; read < maxReadsPerAttempt; read++) {
        const response = await this.readWithTimeout(500);
        if (!response) {
          console.log("Bootstrap read timeout, retrying send...");
          break; // Timeout - retry the send
        }

        console.log("Bootstrap response:", Array.from(response.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));

        // Validate wrapper prefix
        if (response[0] !== WRAPPER_PREFIX) {
          console.log("Unexpected response prefix, reading again...");
          continue;
        }

        // Check if client ID is 0 (bootstrap response)
        const respClientId = response[1] | (response[2] << 8) | (response[3] << 16) | (response[4] << 24);
        if (respClientId !== 0) {
          console.log(`Discarding response for client 0x${respClientId.toString(16)}, reading again...`);
          continue;
        }

        // Verify nonce echo (bytes 5-24)
        let nonceMatch = true;
        for (let i = 0; i < NONCE_SIZE; i++) {
          if (response[5 + i] !== nonce[i]) {
            nonceMatch = false;
            break;
          }
        }
        if (!nonceMatch) {
          console.log("Nonce mismatch (another client's response), reading again...");
          continue;
        }

        // Extract client ID (bytes 25-28, little-endian)
        const newClientId = response[25] |
          (response[26] << 8) |
          (response[27] << 16) |
          (response[28] << 24);

        // Check for error
        if (newClientId === 0xFFFFFFFF) {
          const errorCode = response[29];
          throw new Error(`Bootstrap failed with error code ${errorCode}`);
        }

        this.clientId = newClientId;

        // Extract TTL (bytes 29-30, little-endian)
        this.clientTtl = response[29] | (response[30] << 8);

        // Set expiry time (with 10% buffer for renewal)
        this.clientIdExpiry = Date.now() + (this.clientTtl * 900); // 90% of TTL

        // Schedule renewal
        this.scheduleRenewal();

        console.log(`Viable client ID bootstrapped: 0x${this.clientId.toString(16)}, TTL: ${this.clientTtl}s`);
        return;
      }
    }

    throw new Error("Bootstrap failed after all retries");
  }

  /**
   * Read a single HID report with timeout
   */
  private readWithTimeout(timeoutMs: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.device?.removeEventListener("inputreport", handler);
        resolve(null);
      }, timeoutMs);

      const handler = (ev: HIDInputReportEvent) => {
        clearTimeout(timeoutId);
        this.device?.removeEventListener("inputreport", handler);
        resolve(new Uint8Array(ev.data.buffer));
      };

      this.device?.addEventListener("inputreport", handler);
    });
  }

  /**
   * Schedule client ID renewal before expiry
   */
  private scheduleRenewal(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
    }

    const renewIn = this.clientIdExpiry - Date.now();
    if (renewIn > 0) {
      this.renewalTimer = setTimeout(async () => {
        try {
          await this.bootstrapClientId();
        } catch (e) {
          console.error("Failed to renew client ID:", e);
        }
      }, renewIn);
    }
  }

  getDeviceName(): string | null {
    return this.device?.productName || null;
  }

  async close(): Promise<void> {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = undefined;
    }
    this.clientId = 0;
    this.clientIdExpiry = 0;

    if (this.device) {
      if (this.handleEvent) {
        this.device.removeEventListener("inputreport", this.handleEvent);
        this.handleEvent = undefined;
      }
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
        const buffer = ev.data.buffer as ArrayBuffer;
        this.listener(buffer, ev);
      }
    };
    this.handleEvent = handleEvent;
    this.device.addEventListener("inputreport", handleEvent);
  }

  /**
   * Build wrapped message with client ID
   * Format: [0xDD][client_id:4][protocol][payload...]
   */
  private buildWrappedMessage(protocol: number, payload: number[]): Uint8Array {
    const message = new Uint8Array(MSG_LEN);
    message[0] = WRAPPER_PREFIX;
    // Client ID (little-endian)
    message[1] = this.clientId & 0xff;
    message[2] = (this.clientId >> 8) & 0xff;
    message[3] = (this.clientId >> 16) & 0xff;
    message[4] = (this.clientId >> 24) & 0xff;
    // Protocol
    message[5] = protocol;
    // Payload
    for (let i = 0; i < payload.length && i < MSG_LEN - 6; i++) {
      message[6 + i] = payload[i];
    }
    return message;
  }

  /**
   * Parse wrapped response, stripping wrapper header
   * Input: [0xDD][client_id:4][protocol][payload...]
   * Output: payload starting after protocol byte
   */
  private parseWrappedResponse(data: ArrayBuffer, options: USBSendOptions): Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[] {
    const u8 = new Uint8Array(data);

    // Verify wrapper prefix
    if (u8[0] !== WRAPPER_PREFIX) {
      throw new Error("Invalid response wrapper prefix");
    }

    // Verify client ID matches
    const responseClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
    if (responseClientId !== this.clientId) {
      throw new Error("Response client ID mismatch");
    }

    // Extract payload (skip wrapper header + protocol byte = 6 bytes)
    const payloadBuffer = data.slice(6);
    return this.parseResponse(payloadBuffer, options);
  }

  // Overload signatures for send() - sends VIA commands via wrapper
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
   * Send VIA command via wrapper
   * Wraps: [0xDD][client_id:4][0xFE][via_cmd][args...]
   */
  async send(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]> {
    if (!this.device) throw new Error("USB device not connected");

    // Ensure we have a valid client ID
    await this.ensureClientId();

    // Build VIA command payload
    const payload = [cmd, ...args];
    const message = this.buildWrappedMessage(VIA_PREFIX, payload);

    // Queue the operations to prevent listener collision
    const operation = this.queue.then(async () => {
      return new Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          console.warn("USB Command Timed out waiting for valid response:", cmd);
          reject(new Error("USB Command Timeout"));
        }, 1000);

        this.listener = (data: ArrayBuffer) => {
          const u8 = new Uint8Array(data);

          // Validation: check wrapper prefix and client ID
          if (u8[0] !== WRAPPER_PREFIX) return;
          const respClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
          if (respClientId !== this.clientId) return;

          // Additional validation if provided
          if (options.validateInput) {
            // Pass unwrapped data to validator
            const unwrapped = new Uint8Array(data.slice(6));
            if (!options.validateInput(unwrapped)) {
              return;
            }
          }

          clearTimeout(timeoutId);
          try {
            const result = this.parseWrappedResponse(data, options);
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

  // Overload signatures for sendViable()
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index: number }): Promise<number | bigint>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[]>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index: number }): Promise<number>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index: number }): Promise<number>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index: number }): Promise<number>;
  async sendViable(cmd: number, args: number[], options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array>;
  async sendViable(cmd: number, args: number[], options?: USBSendOptions): Promise<Uint8Array>;

  /**
   * Send Viable command via wrapper
   * Wraps: [0xDD][client_id:4][0xDF][viable_cmd][args...]
   */
  async sendViable(
    cmd: number,
    args: number[],
    options: USBSendOptions = {}
  ): Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]> {
    if (!this.device) throw new Error("USB device not connected");

    // Ensure we have a valid client ID
    await this.ensureClientId();

    // Build Viable command payload
    const payload = [cmd, ...args];
    const message = this.buildWrappedMessage(VIABLE_PREFIX, payload);

    // Queue the operations
    const operation = this.queue.then(async () => {
      return new Promise<Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[]>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          console.warn("Viable Command Timed out:", cmd);
          reject(new Error("USB Command Timeout"));
        }, 1000);

        this.listener = (data: ArrayBuffer) => {
          const u8 = new Uint8Array(data);

          // Validation: check wrapper prefix and client ID
          if (u8[0] !== WRAPPER_PREFIX) return;
          const respClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
          if (respClientId !== this.clientId) return;

          // Check for error response (protocol byte = 0xFF)
          if (u8[5] === 0xFF) {
            clearTimeout(timeoutId);
            const errorCode = u8[6];
            reject(new Error(`Viable protocol error: code ${errorCode}`));
            return;
          }

          // Additional validation if provided
          if (options.validateInput) {
            const unwrapped = new Uint8Array(data.slice(6));
            if (!options.validateInput(unwrapped)) {
              return;
            }
          }

          clearTimeout(timeoutId);
          try {
            const result = this.parseWrappedResponse(data, options);
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

  // Overload signatures for type safety
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
      // For unpack, create a new DataView starting at skipBytes offset
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
        // index is a byte offset, not an element index
        return dv.getUint16(skipBytes + options.index, littleEndian);
      }
      // Read uint16 values using DataView to handle odd byte offsets
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
        // index is a byte offset, not an element index
        return dv.getUint32(skipBytes + options.index, littleEndian);
      }
      // Read uint32 values using DataView to handle odd byte offsets
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

  async getViaBuffer(
    cmd: number,
    size: number,
    options: USBSendOptions = {},
    checkComplete?: (data: number[] | Uint8Array) => boolean
  ): Promise<number[] | Uint8Array> {
    // VIA_BUFFER_CHUNK_SIZE = 22 (32 total - 6 wrapper - 4 VIA response header)
    const chunksize = 22;
    const bytes = options.bytes || 1;
    const alldata: number[] = [];
    let offset = 0;

    while (offset < size) {
      let sz = chunksize;
      if (sz > size - offset) {
        sz = size - offset;
      }

      const args = [...BE16(offset), sz];
      const data = await this.send(cmd, args, options) as Uint8Array;

      if (sz < chunksize) {
        const sliceSize = Math.floor(sz / bytes);
        alldata.push(...Array.from(data).slice(0, sliceSize));
      } else {
        if (Array.isArray(data)) {
          alldata.push(...data);
        } else {
          alldata.push(...Array.from(data));
        }
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

  /**
   * Get keyboard definition via Viable protocol
   * Uses CMD_VIABLE_DEFINITION_SIZE and CMD_VIABLE_DEFINITION_CHUNK
   */
  async getViableDefinition(): Promise<Uint8Array> {
    // Get definition size
    // Response format after wrapper stripped: [cmd_echo][size0][size1][size2][size3]
    const sizeResp = await this.sendViable(
      ViableUSB.CMD_VIABLE_DEFINITION_SIZE,
      [],
      { uint32: true, index: 1 } // Skip cmd_echo
    );
    const size = sizeResp as number;

    // Fetch definition in chunks
    // VIABLE_DEFINITION_CHUNK_SIZE = 22 (32 total - 6 wrapper - 4 response header)
    const chunkSize = 22;
    const alldata: number[] = [];
    let offset = 0;

    while (offset < size) {
      const requestSize = Math.min(chunkSize, size - offset);
      const resp = await this.sendViable(
        ViableUSB.CMD_VIABLE_DEFINITION_CHUNK,
        [...LE16(offset), requestSize],
        { uint8: true }
      );

      const data = resp as Uint8Array;
      // Response format after wrapper stripped: [cmd_echo][offset_lo][offset_hi][actual_size][data...]
      const actualSize = data[3]; // Skip cmd_echo
      for (let i = 0; i < actualSize; i++) {
        alldata.push(data[4 + i]); // Skip cmd_echo + header
      }

      offset += actualSize;
      if (actualSize < requestSize) break; // End of data
    }

    return new Uint8Array(alldata);
  }

  async pushViaBuffer(
    cmd: number,
    size: number,
    data: ArrayBuffer
  ): Promise<void> {
    const buffer = new Uint8Array(data);
    let offset = 0;
    let chunkOffset = 0;
    // VIA_BUFFER_CHUNK_SIZE = 22 (matches get chunk size)
    const chunkSize = 22;

    while (offset < size) {
      const chunk = new Uint8Array(chunkSize);
      for (let i = 0; i < chunk.length && offset < size; i++) {
        chunk[i] = buffer[offset++];
      }

      await this.send(cmd, [...LE16(chunkOffset), ...chunk], {});
      chunkOffset += chunk.length;
    }
  }

  // Overload signatures for getViableEntries()
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { unpack: string; index: number }): Promise<(number | bigint)[]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { unpack: string; index?: undefined }): Promise<(number | bigint)[][]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { uint8: true; index: number }): Promise<number[]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { uint8: true; index?: undefined }): Promise<Uint8Array[]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { uint16: true; index: number }): Promise<number[]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { uint16: true; index?: undefined }): Promise<Uint16Array[]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { uint32: true; index: number }): Promise<number[]>;
  async getViableEntries(getCmd: number, count: number, options: USBSendOptions & { uint32: true; index?: undefined }): Promise<Uint32Array[]>;
  async getViableEntries(getCmd: number, count: number, options?: USBSendOptions): Promise<Uint8Array[]>;

  /**
   * Get multiple entries using Viable protocol
   */
  async getViableEntries(
    getCmd: number,
    count: number,
    options: USBSendOptions = {}
  ): Promise<(Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[])[]> {
    const entries: (Uint8Array | Uint16Array | Uint32Array | number | bigint | (number | bigint)[])[] = [];
    for (let i = 0; i < count; i++) {
      const data = await this.sendViable(getCmd, [i], options);
      entries.push(data);
    }
    return entries;
  }

  // VIA Custom Value Protocol (0x07/0x08/0x09)
  // Channels: 0 = keyboard-specific, 1 = QMK backlight, 2 = QMK rgblight

  /**
   * Get a custom value from the keyboard using VIA custom value protocol.
   * Packet: [0x08][channel][value_id]
   * Response: [0x08][channel][value_id][data...]
   */
  async customValueGet(channel: number, valueId: number, size: number = 2): Promise<Uint8Array> {
    const resp = await this.send(
      ViableUSB.CMD_VIA_LIGHTING_GET_VALUE,
      [channel, valueId],
      {
        uint8: true,
        skipBytes: 3, // Skip cmd_echo, channel, value_id
        // Only resolve on the report that echoes THIS request. Without this,
        // the listener accepts any wrapper/clientId-matched report, so a stray or
        // duplicated report (common on the first connect after a reboot, when the
        // WebHID buffer holds a leftover reply) can be consumed by the wrong
        // customValueGet in the sequential read loop, shifting every subsequent
        // read by one slot and showing a neighboring value's data (e.g. right-hand
        // DPI reading as 1200 when the device holds 400).
        validateInput: (u) =>
          u[0] === ViableUSB.CMD_VIA_LIGHTING_GET_VALUE &&
          u[1] === channel &&
          u[2] === valueId,
      }
    );
    return (resp as Uint8Array).slice(0, size);
  }

  /**
   * Set a custom value on the keyboard using VIA custom value protocol.
   * Packet: [0x07][channel][value_id][data...]
   */
  async customValueSet(channel: number, valueId: number, data: number[]): Promise<void> {
    console.log(`customValueSet: channel=${channel}, valueId=${valueId}, data=[${data.join(', ')}]`);
    await this.send(
      ViableUSB.CMD_VIA_LIGHTING_SET_VALUE,
      [channel, valueId, ...data],
      {}
    );
  }

  /**
   * Save custom values to EEPROM using VIA custom value protocol.
   * Packet: [0x09][channel]
   */
  async customValueSave(channel: number): Promise<void> {
    await this.send(
      ViableUSB.CMD_VIA_LIGHTING_SAVE,
      [channel],
      {}
    );
  }

  // Layer Color convenience methods (channel 0, value_ids 32-47)
  // Color format: 2 bytes [hue, sat] (0-255 range, QMK HSV)

  static readonly LAYER_COLOR_VALUE_ID_BASE = 32;
  static readonly LAYER_COLOR_CHANNEL = 0;

  /**
   * Get layer color from keyboard.
   * Returns HSV (hue, sat) - value/brightness controlled separately.
   */
  async getLayerColor(layer: number): Promise<{ hue: number; sat: number }> {
    const valueId = ViableUSB.LAYER_COLOR_VALUE_ID_BASE + layer;
    const data = await this.customValueGet(ViableUSB.LAYER_COLOR_CHANNEL, valueId, 2);
    return { hue: data[0], sat: data[1] };
  }

  /**
   * Set layer color on keyboard.
   * Takes HSV values (0-255 range).
   */
  async setLayerColor(layer: number, hue: number, sat: number): Promise<void> {
    const valueId = ViableUSB.LAYER_COLOR_VALUE_ID_BASE + layer;
    console.log(`setLayerColor: layer=${layer}, valueId=${valueId}, hue=${hue}, sat=${sat}`);
    await this.customValueSet(ViableUSB.LAYER_COLOR_CHANNEL, valueId, [hue, sat]);
    await this.customValueSave(ViableUSB.LAYER_COLOR_CHANNEL);
  }

  /**
   * Get all layer colors (for initial sync).
   * Returns array of 16 HSV values.
   */
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

// Export singleton instance
export const usbInstance = new ViableUSB();

// Backward compatibility alias
export { ViableUSB as VialUSB };

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
    // Standard Vial protocol doesn't require client ID bootstrap
    // Just mark as ready
    if (this.clientId === 0) {
      this.clientId = 1; // Use a dummy client ID for standard Vial
      this.clientIdExpiry = Date.now() + (DEFAULT_TTL_SECS * 1000);
    }
    return;
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

    // Fallback: if bootstrap fails, use dummy client ID
    console.log("Bootstrap failed, using fallback client ID");
    this.clientId = 1;
    this.clientTtl = DEFAULT_TTL_SECS;
    this.clientIdExpiry = Date.now() + (DEFAULT_TTL_SECS * 1000);
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
    // Client ID (little-endian) - use dummy client ID for standard Vial
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

    // For standard Vial, just extract payload after prefix + protocol byte
    // The response format is: [0xDD][protocol][payload...]
    // We need to find where the actual payload starts
    // Try different offsets based on what the firmware actually returns
    
    let payloadStart = 2; // Default: skip prefix + protocol byte
    
    // Check if there's a client ID in the response (some firmwares include it)
    // If bytes 1-4 look like a client ID (not 0), adjust offset
    const respClientId = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
    if (respClientId !== 0) {
      // Firmware included client ID, skip 6 bytes (prefix +
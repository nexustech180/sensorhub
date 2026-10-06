/*
 * GOLD-VAR ESP32 WIFI GATEWAY  (board: "ESP32 Dev Module")
 *
 * No extra libraries needed - only what comes with the ESP32 board package.
 *
 * This is a PASS-THROUGH: it accepts ANY readable text line the Arduino Mega
 * sends on Serial3 and serves the most recent lines at
 *     http://<ESP32-IP>/data      (also http://goldvar.local/data on most laptops)
 * Gold Var Sensor Hub works out what the text means (its built-in parser reads
 * "name=value" text; its optional AI helper deciphers anything else). So you can
 * change the Mega and node code freely - this ESP32 never needs re-flashing.
 *
 * Recommended Mega output, one line per second:
 *     node1_pir=ON!danger node2_sound=305.4ADC!ok node4_distance=45cm!warning
 *   name=value[unit][!ok|!warning|!danger]   (the !marker is optional)
 *
 * WiFi: joins your WiFi or phone hotspot (2.4 GHz). If it is not found within
 * 30 s, the ESP32 starts its OWN hotspot "GOLD-VAR" (password goldvar123);
 * then use http://192.168.4.1/data
 *
 * Optional: the ESP32 sends "$ST,<wifi>,<ip>*HH" to the Mega every 2 s so the
 * Mega can show the address on its LCD (wifi: 0 searching, 1 on WiFi, 2 own hotspot).
 *
 * Wiring (common GND between Mega and ESP32 is REQUIRED):
 *   Mega TX3 (D14) --[1k]--+-- ESP32 GPIO16 (RX2)      5V -> 3.3V divider
 *                          |
 *                         [2k]
 *                          |
 *                         GND
 *   Mega RX3 (D15) <-------- ESP32 GPIO17 (TX2)
 *   Power the ESP32 from USB or 5V -> VIN (not from the Mega's 3.3V pin).
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ============================== USER SETTINGS ===============================
const char* WIFI_SSID = "YOUR_WIFI_OR_HOTSPOT_NAME";
const char* WIFI_PASS = "YOUR_WIFI_OR_HOTSPOT_PASSWORD";

const char* AP_SSID   = "GOLD-VAR";     // backup hotspot made by the ESP32 itself
const char* AP_PASS   = "goldvar123";   // at least 8 characters

#define MEGA_RX_PIN      16      // ESP32 receives from Mega TX3 (through the divider)
#define MEGA_TX_PIN      17      // ESP32 sends to Mega RX3
#define MEGA_BAUD        115200
#define LINE_KEEP_MS     5000    // serve lines received in the last 5 s
#define MEGA_TIMEOUT_MS  5000    // no line for this long -> mega_link=OFF
#define WIFI_WAIT_MS     30000   // look for your WiFi this long, then start GOLD-VAR hotspot
// ============================================================================

#define MAX_LINE   400           // longest line accepted (longer ones are dropped as noise)
#define KEEP_LINES 12            // how many recent lines are remembered

struct RecentLine {
  char text[MAX_LINE + 1];
  unsigned long at;
};

HardwareSerial& MEGA = Serial2;
WebServer server(80);

RecentLine recent[KEEP_LINES];
int recentNewest = -1;           // index of the newest line, -1 = none yet
unsigned long lastLineMs = 0;
unsigned long goodLines = 0, droppedLines = 0;

char lineBuf[MAX_LINE + 1];
size_t lineLen = 0;
bool lineBad = false;            // too long or contains non-text bytes (electrical noise)

bool apStarted = false;
bool mdnsStarted = false;

// ------------------------------- Mega link ----------------------------------
void storeLine(const char* text) {
  recentNewest = (recentNewest + 1) % KEEP_LINES;
  strncpy(recent[recentNewest].text, text, MAX_LINE);
  recent[recentNewest].text[MAX_LINE] = '\0';
  recent[recentNewest].at = millis();
  lastLineMs = millis();
  goodLines++;
}

void endLine() {
  // Trim trailing spaces
  while (lineLen > 0 && lineBuf[lineLen - 1] == ' ') lineLen--;
  lineBuf[lineLen] = '\0';
  if (lineBad || lineLen < 2) {
    if (lineLen > 0 || lineBad) droppedLines++;
  } else {
    storeLine(lineBuf);
  }
  lineLen = 0;
  lineBad = false;
}

void readMega() {
  while (MEGA.available()) {
    char c = (char)MEGA.read();
    if (c == '\n') {
      endLine();
    } else if (c == '\r') {
      // ignore
    } else if (c == '\t') {
      if (lineLen < MAX_LINE) lineBuf[lineLen++] = ' ';
      else lineBad = true;
    } else if (c < 0x20 || c > 0x7E) {
      lineBad = true;            // garbage byte: drop the whole line
    } else if (lineLen < MAX_LINE) {
      lineBuf[lineLen++] = c;
    } else {
      lineBad = true;
    }
  }
}

bool megaLinkUp() {
  return recentNewest >= 0 && millis() - lastLineMs < MEGA_TIMEOUT_MS;
}

// --------------------------------- WiFi -------------------------------------
// 1 = on your WiFi, 2 = own hotspot, 0 = still searching
int wifiMode() {
  if (WiFi.status() == WL_CONNECTED) return 1;
  if (apStarted) return 2;
  return 0;
}

String currentIp() {
  if (WiFi.status() == WL_CONNECTED) return WiFi.localIP().toString();
  if (apStarted) return WiFi.softAPIP().toString();
  return "0.0.0.0";
}

void manageWifi() {
  static bool wasConnected = false;
  bool connected = WiFi.status() == WL_CONNECTED;

  if (connected && !wasConnected) {
    Serial.printf("[WIFI] Connected to %s\n", WIFI_SSID);
    Serial.printf("[WIFI] Sensor Hub address: %s   (or goldvar.local)\n", WiFi.localIP().toString().c_str());
    if (!mdnsStarted && MDNS.begin("goldvar")) {
      MDNS.addService("http", "tcp", 80);
      mdnsStarted = true;
    }
  } else if (!connected && wasConnected) {
    Serial.println("[WIFI] Connection lost - reconnecting...");
  }
  wasConnected = connected;

  // Backup: our own hotspot if your WiFi was never found after boot
  if (!connected && !apStarted && millis() > WIFI_WAIT_MS) {
    Serial.printf("[WIFI] '%s' not found - starting own hotspot '%s' (password %s)\n", WIFI_SSID, AP_SSID, AP_PASS);
    WiFi.disconnect(true);  // stop searching; channel hopping would disturb the hotspot
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    apStarted = true;
    Serial.printf("[WIFI] Join '%s' and use Sensor Hub address: %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
    Serial.println("[WIFI] (Restart the ESP32 to try your WiFi again)");
  }
}

// Optional status line for the Mega's LCD: "$ST,<wifi>,<ip>*HH"
void sendStatusToMega() {
  static unsigned long last = 0;
  if (millis() - last < 2000) return;
  last = millis();
  char buf[48];
  int n = snprintf(buf, sizeof(buf), "$ST,%d,%s", wifiMode(), currentIp().c_str());
  if (n <= 0 || n >= (int)sizeof(buf) - 6) return;
  uint8_t cs = 0;
  for (int i = 1; i < n; i++) cs ^= (uint8_t)buf[i];
  snprintf(buf + n, sizeof(buf) - n, "*%02X\r\n", cs);
  MEGA.print(buf);
}

// ------------------------------ Web server ----------------------------------
void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Cache-Control", "no-store");
}

// Newest lines first (so the newest value wins), identical lines only once,
// then one line of gateway info.
void handleData() {
  String out;
  out.reserve(KEEP_LINES * 120 + 80);
  unsigned long now = millis();
  for (int k = 0; k < KEEP_LINES && recentNewest >= 0; k++) {
    int i = (recentNewest - k + KEEP_LINES) % KEEP_LINES;
    if (recent[i].text[0] == '\0' || now - recent[i].at > LINE_KEEP_MS) break;
    bool duplicate = false;
    for (int j = 0; j < k && !duplicate; j++) {
      int jj = (recentNewest - j + KEEP_LINES) % KEEP_LINES;
      duplicate = strcmp(recent[jj].text, recent[i].text) == 0;
    }
    if (!duplicate) {
      out += recent[i].text;
      out += '\n';
    }
  }
  out += megaLinkUp() ? "mega_link=ON!ok" : "mega_link=OFF!danger";
  out += " wifi_rssi=";
  out += WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  out += "dBm uptime_s=";
  out += millis() / 1000;
  out += '\n';
  sendCors();
  server.send(200, "text/plain; charset=utf-8", out);
}

void handleOptions() {
  sendCors();
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

// --------------------------------- Main -------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== GOLD-VAR ESP32 WIFI GATEWAY (pass-through) ===");

  for (int i = 0; i < KEEP_LINES; i++) recent[i].text[0] = '\0';

  MEGA.setRxBufferSize(2048);
  MEGA.begin(MEGA_BAUD, SERIAL_8N1, MEGA_RX_PIN, MEGA_TX_PIN);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[WIFI] Looking for '%s' (2.4 GHz)...\n", WIFI_SSID);

  server.on("/data", HTTP_GET, handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.on("/", HTTP_GET, []() {
    sendCors();
    server.send(200, "text/plain", "GOLD-VAR gateway - readings at /data");
  });
  server.begin();
}

void loop() {
  readMega();
  manageWifi();
  server.handleClient();
  sendStatusToMega();

  static unsigned long lastLog = 0;
  if (millis() - lastLog >= 10000) {
    lastLog = millis();
    Serial.printf("[STAT] Mega=%s  lines kept/dropped=%lu/%lu  WiFi=%s  IP=%s\n",
                  megaLinkUp() ? "OK" : "NO DATA", goodLines, droppedLines,
                  wifiMode() == 1 ? "connected" : wifiMode() == 2 ? "own hotspot" : "searching",
                  currentIp().c_str());
    if (recentNewest >= 0) Serial.printf("[STAT] Last line: %s\n", recent[recentNewest].text);
  }
}

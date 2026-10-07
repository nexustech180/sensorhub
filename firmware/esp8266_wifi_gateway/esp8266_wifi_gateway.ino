/*
 * GOLD-VAR ESP8266 WIFI GATEWAY  (ESP8266MOD / ESP-12E/F: NodeMCU, Wemos D1 mini, ...)
 * Board: "NodeMCU 1.0 (ESP-12E Module)" (or "LOLIN(WEMOS) D1 R2 & mini", or
 * "Generic ESP8266 Module" for a bare module). No extra libraries needed: everything
 * comes with the "esp8266 by ESP8266 Community" board package.
 *
 * This is a PASS-THROUGH: it accepts ANY readable text line the Arduino Mega sends
 * and serves the most recent lines at
 *     http://<ESP-IP>/data       (also http://goldvar.local/data on most laptops)
 * Gold Var Sensor Hub works out what the text means, so you can change the Mega and
 * node code freely - this ESP8266 never needs re-flashing.
 *
 * Open http://<ESP-IP>/ in a browser for a status page (instead of the Serial Monitor).
 *
 * WiFi: joins your WiFi or phone hotspot (2.4 GHz). If it is not found within 30 s,
 * the ESP8266 starts its OWN hotspot "GOLD-VAR" (password goldvar123); then use
 * http://192.168.4.1/data
 *
 * The ESP8266 has only one full serial port. After start-up it is moved from the USB
 * pins to GPIO13/GPIO15 (Serial.swap()), so USB uploading still works and the Mega
 * talks on separate pins. That is why there is no Serial Monitor output after boot.
 *
 * Wiring (common GND between Mega and ESP8266 is REQUIRED):
 *   Mega TX3 (D14) --[1k]--+-- ESP8266 GPIO13 (D7)     5V -> 3.3V divider
 *                          |
 *                         [2k]
 *                          |
 *                         GND
 *   Mega RX3 (D15) <-------- ESP8266 GPIO15 (D8)      (optional: shows the IP on the Mega LCD)
 *   Power the board from USB or 5V -> VIN (not from the Mega's 3.3V pin: the
 *   ESP8266 draws up to ~300 mA when sending WiFi).
 */
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>

// ============================== USER SETTINGS ===============================
const char* WIFI_SSID = "YOUR_WIFI_OR_HOTSPOT_NAME";
const char* WIFI_PASS = "YOUR_WIFI_OR_HOTSPOT_PASSWORD";

const char* AP_SSID   = "GOLD-VAR";     // backup hotspot made by the ESP8266 itself
const char* AP_PASS   = "goldvar123";   // at least 8 characters

#define MEGA_BAUD        115200  // must match GATEWAY_BAUD in the Mega sketch
#define LINE_KEEP_MS     5000    // serve lines received in the last 5 s
#define MEGA_TIMEOUT_MS  5000    // no line for this long -> mega_link=OFF
#define WIFI_WAIT_MS     30000   // look for your WiFi this long, then start GOLD-VAR hotspot
// ============================================================================

#define MAX_LINE   400           // longest line accepted (longer ones are dropped as noise)
#define KEEP_LINES 8             // how many recent lines are remembered (ESP8266 has little RAM)

struct RecentLine {
  char text[MAX_LINE + 1];
  unsigned long at;
};

ESP8266WebServer server(80);

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
  while (lineLen > 0 && lineBuf[lineLen - 1] == ' ') lineLen--;   // trim trailing spaces
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
  while (Serial.available()) {
    char c = (char)Serial.read();
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
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !mdnsStarted && MDNS.begin("goldvar")) {
    MDNS.addService("http", "tcp", 80);
    mdnsStarted = true;
  }

  // Backup: our own hotspot if your WiFi was never found after boot
  if (!connected && !apStarted && millis() > WIFI_WAIT_MS) {
    WiFi.disconnect(true);  // stop searching; channel hopping would disturb the hotspot
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    apStarted = true;
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
  Serial.print(buf);
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

// Human-readable status page (replaces the Serial Monitor)
void handleStatus() {
  String s;
  s.reserve(1200);
  s += F("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
         "<meta http-equiv=refresh content=5><title>GOLD-VAR gateway</title>"
         "<style>body{font:16px system-ui,sans-serif;margin:16px;max-width:640px}td{padding:4px 12px 4px 0}"
         "code{background:#eee;padding:2px 4px;word-break:break-all}.ok{color:#2f7d4f}.bad{color:#b3261e}</style>"
         "<h2>GOLD-VAR gateway (ESP8266)</h2><table>");
  s += F("<tr><td>Mega data</td><td class=");
  s += megaLinkUp() ? F("ok>receiving") : F("bad>NO DATA - check TX3-&gt;D7 wire, divider and GND");
  s += F("</td></tr><tr><td>Lines kept / dropped</td><td>");
  s += goodLines; s += F(" / "); s += droppedLines;
  s += F("</td></tr><tr><td>WiFi</td><td>");
  s += wifiMode() == 1 ? String(F("connected to ")) + WIFI_SSID + F(" (") + WiFi.RSSI() + F(" dBm)")
     : wifiMode() == 2 ? String(F("own hotspot ")) + AP_SSID : String(F("searching"));
  s += F("</td></tr><tr><td>Address for Sensor Hub</td><td><b>");
  s += currentIp();
  s += F("</b></td></tr><tr><td>Uptime</td><td>");
  s += millis() / 1000;
  s += F(" s</td></tr></table><p>Last line from the Mega:</p><p><code>");
  if (recentNewest >= 0) {
    for (const char* p = recent[recentNewest].text; *p; p++) {   // HTML-escape
      if (*p == '<') s += F("&lt;"); else if (*p == '>') s += F("&gt;"); else if (*p == '&') s += F("&amp;"); else s += *p;
    }
  } else {
    s += F("(nothing yet)");
  }
  s += F("</code></p><p><a href=/data>/data</a> (what the app reads)</p>");
  sendCors();
  server.send(200, "text/html; charset=utf-8", s);
}

// --------------------------------- Main -------------------------------------
void setup() {
  for (int i = 0; i < KEEP_LINES; i++) recent[i].text[0] = '\0';

  Serial.begin(MEGA_BAUD);
  Serial.setRxBufferSize(1024);
  Serial.println();
  Serial.println(F("=== GOLD-VAR ESP8266 WIFI GATEWAY ==="));
  Serial.println(F("Serial now moves to GPIO13/GPIO15 (D7/D8) for the Mega."));
  Serial.println(F("Open http://<this board's IP>/ in a browser for the status page."));
  Serial.flush();
  Serial.swap();   // UART0 -> RX on GPIO13 (D7), TX on GPIO15 (D8)

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  server.on("/data", HTTP_GET, handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.on("/", HTTP_GET, handleStatus);
  server.begin();
}

void loop() {
  readMega();
  manageWifi();
  if (mdnsStarted) MDNS.update();
  server.handleClient();
  sendStatusToMega();
}

/*
 * Gold Var Sensor Hub — ESP32 sensor board
 * Serves the latest readings as JSON at  http://<board-ip>/data
 *
 * Sensors (change pins below to match your wiring):
 *   HC-SR04 ultrasonic   TRIG -> GPIO 5, ECHO -> GPIO 18 (ECHO is 5 V: use a 1k/2k divider)
 *   SW-420 vibration     DO   -> GPIO 19
 *   Sound (KY-037/MAX4466) AO -> GPIO 34
 *   Turbidity (analog)   AO   -> GPIO 35 (5 V sensor: use a divider, set TURB_DIVIDER)
 *   pH (PH-4502C)        PO   -> GPIO 32 (5 V module: use a divider, set PH_DIVIDER)
 *
 * The dashboard classifies readings by key name, so you can add more sensors just by
 * adding more "key": value pairs to the JSON (e.g. "temperature_c", "humidity", "gas_ppm").
 */
#include <WiFi.h>
#include <WebServer.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

#define PIN_TRIG   5
#define PIN_ECHO   18
#define PIN_VIB    19
#define PIN_SOUND  34
#define PIN_TURB   35
#define PIN_PH     32

// --- calibration ---
const float TURB_DIVIDER = 1.5;    // sensor volts = ADC volts * divider (e.g. 10k/20k divider → 1.5)
const float PH_DIVIDER   = 1.5;
const float PH_SLOPE     = -5.70;  // pH per volt — calibrate with pH 4 and pH 7 buffers
const float PH_OFFSET    = 21.34;  // pH = PH_SLOPE * volts + PH_OFFSET
const float SOUND_DB_OFFSET = 25.0; // rough dB calibration against a phone sound meter
const int   VIB_FULL_SCALE  = 50;   // SW-420 pulses per second counted as 100 %

WebServer server(80);

volatile uint32_t vibPulses = 0;
void IRAM_ATTR onVibration() { vibPulses++; }

float distanceCm = -1, vibrationPct = 0, soundDb = 0, turbidityNtu = 0, phValue = 7;
unsigned long lastRead = 0;

float readVolts(int pin, int samples = 20) {
  uint32_t mv = 0;
  for (int i = 0; i < samples; i++) { mv += analogReadMilliVolts(pin); delay(2); }
  return mv / (float)samples / 1000.0;
}

float readDistance() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 30000);
  return us ? us * 0.0343 / 2.0 : -1;   // -1 = no echo
}

float readSoundDb() {
  unsigned long start = millis();
  int lo = 4095, hi = 0;
  while (millis() - start < 50) {
    int v = analogRead(PIN_SOUND);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  int p2p = max(hi - lo, 1);
  return 20.0 * log10((float)p2p) + SOUND_DB_OFFSET;
}

float readTurbidity() {
  float v = readVolts(PIN_TURB) * TURB_DIVIDER;
  float ntu = -1120.4 * v * v + 5742.3 * v - 4352.9;  // common curve for the DFRobot-style sensor
  return constrain(ntu, 0, 3000);
}

float readPh() {
  float v = readVolts(PIN_PH) * PH_DIVIDER;
  return constrain(PH_SLOPE * v + PH_OFFSET, 0, 14);
}

void readSensors() {
  distanceCm = readDistance();
  soundDb = readSoundDb();
  turbidityNtu = readTurbidity();
  phValue = readPh();

  static unsigned long lastVib = millis();
  unsigned long now = millis();
  noInterrupts(); uint32_t pulses = vibPulses; vibPulses = 0; interrupts();
  float perSec = pulses * 1000.0 / max(now - lastVib, 1UL);
  lastVib = now;
  vibrationPct = min(100.0f, perSec * 100.0f / VIB_FULL_SCALE);
}

void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Cache-Control", "no-store");
}

void handleData() {
  String j = "{";
  j += "\"device\":\"esp32-sensors\",";
  j += "\"ultrasonic_cm\":" + (distanceCm > 0 ? String(distanceCm, 1) : String("null")) + ",";
  j += "\"vibration\":" + String(vibrationPct, 1) + ",";
  j += "\"sound_db\":" + String(soundDb, 1) + ",";
  j += "\"turbidity_ntu\":" + String(turbidityNtu, 2) + ",";
  j += "\"ph\":" + String(phValue, 2) + ",";
  j += "\"wifi_rssi\":" + String(WiFi.RSSI()) + ",";
  j += "\"uptime_s\":" + String(millis() / 1000);
  j += "}";
  sendCors();
  server.send(200, "application/json", j);
}

void handleOptions() {
  sendCors();
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_VIB, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_VIB), onVibration, RISING);
  analogReadResolution(12);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.println();
  Serial.print("Sensor board ready: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/data   <- put this IP in Gold Var Sensor Hub settings");

  server.on("/data", HTTP_GET, handleData);
  server.on("/data", HTTP_OPTIONS, handleOptions);
  server.on("/", HTTP_GET, []() { sendCors(); server.send(200, "text/plain", "Gold Var Sensor Hub ESP32 — readings at /data"); });
  server.begin();
}

void loop() {
  server.handleClient();
  if (millis() - lastRead >= 500) {
    lastRead = millis();
    readSensors();
  }
}

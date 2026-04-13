/**
 * @file    bms_firmware.c
 * @brief   Battery Management System — STM32F103C8 (Blue Pill)
 *
 * Reads voltage, current, temperature, and flame sensors every 1 second,
 * detects faults, controls relay/buzzer/LEDs, drives a 16x2 I2C LCD,
 * and streams JSON over UART1 at 115 200 baud for the FastAPI backend.
 *
 * ─── Pin assignment ──────────────────────────────────────────────────────────
 *  PA0  ADC_CH0   Voltage divider output  (10 kΩ / 3.3 kΩ)
 *  PA1  ADC_CH1   ACS712-20A current      (2.5 V @ 0 A, 100 mV/A)
 *  PA2  ADC_CH2   LM35 temperature        (10 mV/°C)
 *  PA3  ADC_CH3   Flame sensor (analogue) (< 1.0 V = fire)
 *  PA9  USART1_TX  → backend Rx
 *  PA10 USART1_RX  ← backend Tx (unused in this firmware)
 *  PB0  Relay       active-HIGH → disconnect load / charger on fault
 *  PB1  Buzzer      active-HIGH → audible alert
 *  PB2  LED Red     active-HIGH → fault / fire
 *  PB3  LED Yellow  active-HIGH → low battery warning
 *  PB4  LED Green   active-HIGH → normal operation
 *  PB6  I2C1_SCL   → LCD PCF8574 backpack
 *  PB7  I2C1_SDA   → LCD PCF8574 backpack (I2C address 0x27)
 *
 * ─── Safety thresholds (from project paper Table 3.7) ────────────────────────
 *  Over-voltage  > 12.6 V   → relay open, red LED, buzzer
 *  Under-voltage < 9.0  V   → relay open, red LED, buzzer
 *  Over-current  > 10.0 A   → relay open, red LED, buzzer
 *  Over-temp     > 50.0 °C  → relay open, red LED, buzzer
 *  Low battery   ≤ 10.0 V   → yellow LED, buzzer (relay stays closed)
 *  Fire detected (flame < 1.0 V analogue / PA3 digital LOW) → relay open, red LED, continuous buzzer
 *
 * ─── Build environment ───────────────────────────────────────────────────────
 *  STM32CubeIDE 1.x, HAL driver pack STM32CubeF1 v1.8+
 *  Add this file to Core/Src/ and include Core/Inc/main.h for HAL types.
 *  CubeMX configuration required:
 *    - RCC: HSE crystal 8 MHz, SYSCLK 72 MHz (PLL x9)
 *    - ADC1: continuous mode OFF, scan mode ON, 4 channels (CH0–CH3)
 *    - USART1: 115200 8N1, TX only (PA9)
 *    - I2C1: 100 kHz standard mode (PB6/PB7)
 *    - GPIO outputs: PB0–PB4 push-pull, no pull
 *    - TIM2: 1 Hz timebase interrupt (optional; can use HAL_Delay instead)
 */

#include "main.h"
#include <stdio.h>
#include <string.h>
#include <math.h>

/* ── HAL handles (defined by CubeMX-generated main.c) ─────────────────────── */
extern ADC_HandleTypeDef  hadc1;
extern I2C_HandleTypeDef  hi2c1;
extern UART_HandleTypeDef huart1;

/* ── Constants ─────────────────────────────────────────────────────────────── */
#define ADC_REF_V        3.3f
#define ADC_MAX          4095.0f

/* Voltage divider: R1 = 10 kΩ (high side), R2 = 3.3 kΩ (low side)          */
#define VDIV_RATIO       ((10000.0f + 3300.0f) / 3300.0f)   /* ≈ 4.030 */

/* ACS712-20A: midpoint 2.5 V, sensitivity 100 mV/A                           */
#define ACS_MIDPOINT_V   2.5f
#define ACS_SENSITIVITY  0.100f   /* V/A */

/* LM35: 10 mV/°C, output directly proportional to temperature                */
#define LM35_MV_PER_DEG  0.010f   /* V/°C */

/* Flame sensor: analogue reading < threshold → fire (module pulls LOW on fire)*/
#define FLAME_FIRE_V     1.0f

/* Safety limits */
#define THRESH_OV        12.6f
#define THRESH_UV        9.0f
#define THRESH_OC        10.0f
#define THRESH_OT        50.0f
#define THRESH_LB        10.0f    /* low-battery warning (relay stays closed) */

/* SOC estimation: linear between UV and OV                                    */
#define SOC_MIN_V        9.0f
#define SOC_MAX_V        12.6f

/* I2C LCD */
#define LCD_ADDR         (0x27 << 1)   /* PCF8574 address, shifted for HAL    */
#define LCD_BACKLIGHT    0x08
#define LCD_EN           0x04
#define LCD_RS           0x01

/* GPIO aliases */
#define RELAY_PIN        GPIO_PIN_0
#define RELAY_PORT       GPIOB
#define BUZZER_PIN       GPIO_PIN_1
#define BUZZER_PORT      GPIOB
#define LED_RED_PIN      GPIO_PIN_2
#define LED_RED_PORT     GPIOB
#define LED_YEL_PIN      GPIO_PIN_3
#define LED_YEL_PORT     GPIOB
#define LED_GRN_PIN      GPIO_PIN_4
#define LED_GRN_PORT     GPIOB

/* ── Fault flags ────────────────────────────────────────────────────────────── */
typedef struct {
    uint8_t over_voltage   : 1;
    uint8_t under_voltage  : 1;
    uint8_t over_current   : 1;
    uint8_t over_temp      : 1;
    uint8_t fire           : 1;
    uint8_t low_battery    : 1;  /* warning only — relay stays closed */
} FaultFlags;

/* ── Forward declarations ──────────────────────────────────────────────────── */
static uint16_t ADC_ReadChannel(uint32_t channel);
static float    ADC_ToVoltage(uint16_t raw);
static void     LCD_Init(void);
static void     LCD_SendCmd(uint8_t cmd);
static void     LCD_SendData(uint8_t data);
static void     LCD_I2C_Write(uint8_t data);
static void     LCD_SetCursor(uint8_t col, uint8_t row);
static void     LCD_Print(const char *str);
static void     LCD_Update(float voltage, float current, float temp, float soc,
                            FaultFlags f, uint8_t charging);
static void     Actuators_Update(FaultFlags f);
static FaultFlags Detect_Faults(float v, float i, float t, uint8_t flame,
                                  uint8_t charging);
static float    Calc_SOC(float voltage);
static void     UART_SendJSON(float v, float i, float t, uint8_t flame,
                               float soc, uint8_t charging);

/* ══════════════════════════════════════════════════════════════════════════════
 * BMS_Main — call this from main() after all HAL_Init / MX_* calls
 * ══════════════════════════════════════════════════════════════════════════════ */
void BMS_Main(void)
{
    LCD_Init();
    LCD_SetCursor(0, 0); LCD_Print("  BMS Monitor   ");
    LCD_SetCursor(0, 1); LCD_Print(" Initialising...");
    HAL_Delay(1500);

    /* Charging state machine (mirrors virtual sensor logic) */
    uint8_t charging = 0;

    while (1)
    {
        /* ── 1. Read sensors ─────────────────────────────────────────────── */
        uint16_t raw_v    = ADC_ReadChannel(ADC_CHANNEL_0);
        uint16_t raw_i    = ADC_ReadChannel(ADC_CHANNEL_1);
        uint16_t raw_t    = ADC_ReadChannel(ADC_CHANNEL_2);
        uint16_t raw_fl   = ADC_ReadChannel(ADC_CHANNEL_3);

        float vpin  = ADC_ToVoltage(raw_v);
        float ipin  = ADC_ToVoltage(raw_i);
        float tpin  = ADC_ToVoltage(raw_t);
        float flpin = ADC_ToVoltage(raw_fl);

        /* ── 2. Convert to physical quantities ──────────────────────────── */
        float voltage     = vpin  * VDIV_RATIO;
        float current     = (ipin  - ACS_MIDPOINT_V) / ACS_SENSITIVITY;
        float temperature = tpin  / LM35_MV_PER_DEG;
        uint8_t flame     = (flpin < FLAME_FIRE_V) ? 1 : 0;

        /* Detect charging: current is negative (charge flows in)           */
        if (current < -0.5f) {
            charging = 1;
        } else if (current > 0.2f) {
            charging = 0;
        }

        /* SOC */
        float soc = Calc_SOC(voltage);

        /* ── 3. Fault detection ─────────────────────────────────────────── */
        FaultFlags faults = Detect_Faults(voltage, current, temperature,
                                           flame, charging);

        /* ── 4. Actuators (relay / buzzer / LEDs) ───────────────────────── */
        Actuators_Update(faults);

        /* ── 5. LCD display ─────────────────────────────────────────────── */
        LCD_Update(voltage, current, temperature, soc, faults, charging);

        /* ── 6. UART JSON stream to backend ─────────────────────────────── */
        UART_SendJSON(voltage, current, temperature, flame, soc, charging);

        /* ── 7. 1-second cycle ──────────────────────────────────────────── */
        HAL_Delay(1000);
    }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ADC helpers
 * ══════════════════════════════════════════════════════════════════════════════ */
static uint16_t ADC_ReadChannel(uint32_t channel)
{
    ADC_ChannelConfTypeDef cfg = {0};
    cfg.Channel      = channel;
    cfg.Rank         = ADC_REGULAR_RANK_1;
    cfg.SamplingTime = ADC_SAMPLETIME_55CYCLES_5;
    HAL_ADC_ConfigChannel(&hadc1, &cfg);

    HAL_ADC_Start(&hadc1);
    HAL_ADC_PollForConversion(&hadc1, HAL_MAX_DELAY);
    uint16_t val = (uint16_t)HAL_ADC_GetValue(&hadc1);
    HAL_ADC_Stop(&hadc1);
    return val;
}

static float ADC_ToVoltage(uint16_t raw)
{
    return ((float)raw / ADC_MAX) * ADC_REF_V;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Fault detection
 * ══════════════════════════════════════════════════════════════════════════════ */
static FaultFlags Detect_Faults(float v, float i, float t, uint8_t flame,
                                  uint8_t charging)
{
    FaultFlags f = {0};

    /* Over-voltage only when not charging (charging near 12.6 V is normal) */
    if (v > THRESH_OV && !charging)  f.over_voltage  = 1;
    if (v < THRESH_UV)               f.under_voltage = 1;
    if (i > THRESH_OC)               f.over_current  = 1;
    if (t > THRESH_OT)               f.over_temp     = 1;
    if (flame)                       f.fire          = 1;

    /* Low-battery warning (relay stays closed) */
    if (v >= THRESH_UV && v <= THRESH_LB && !charging)
        f.low_battery = 1;

    return f;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * SOC estimation (linear voltage model)
 * ══════════════════════════════════════════════════════════════════════════════ */
static float Calc_SOC(float voltage)
{
    float soc = (voltage - SOC_MIN_V) / (SOC_MAX_V - SOC_MIN_V) * 100.0f;
    if (soc < 0.0f)   soc = 0.0f;
    if (soc > 100.0f) soc = 100.0f;
    return soc;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Actuator control
 * ══════════════════════════════════════════════════════════════════════════════ */
static void Actuators_Update(FaultFlags f)
{
    /* Relay-tripping faults (exclude low_battery which is warning-only) */
    uint8_t trip = f.over_voltage | f.under_voltage |
                   f.over_current | f.over_temp | f.fire;

    /* Relay: HIGH = open (disconnect load) */
    HAL_GPIO_WritePin(RELAY_PORT, RELAY_PIN,
                      trip ? GPIO_PIN_SET : GPIO_PIN_RESET);

    /* Buzzer: continuous on fire, on for any tripping fault, brief beep on warning */
    HAL_GPIO_WritePin(BUZZER_PORT, BUZZER_PIN,
                      (trip || f.low_battery) ? GPIO_PIN_SET : GPIO_PIN_RESET);

    /* LEDs */
    HAL_GPIO_WritePin(LED_RED_PORT,  LED_RED_PIN,
                      trip ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(LED_YEL_PORT,  LED_YEL_PIN,
                      f.low_battery ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_GPIO_WritePin(LED_GRN_PORT,  LED_GRN_PIN,
                      (!trip && !f.low_battery) ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * UART JSON output
 * Format: {"voltage":11.52,"current":2.84,"temperature":33.1,"flame":0,"soc":74.6,"charging":0}\n
 * ══════════════════════════════════════════════════════════════════════════════ */
static void UART_SendJSON(float v, float i, float t, uint8_t flame,
                           float soc, uint8_t charging)
{
    char buf[128];
    int len = snprintf(buf, sizeof(buf),
        "{\"voltage\":%.2f,\"current\":%.2f,\"temperature\":%.1f,"
        "\"flame\":%d,\"soc\":%.1f,\"charging\":%d}\n",
        (double)v, (double)i, (double)t, (int)flame, (double)soc, (int)charging);
    HAL_UART_Transmit(&huart1, (uint8_t *)buf, (uint16_t)len, HAL_MAX_DELAY);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 16×2 I2C LCD driver (PCF8574 backpack, address 0x27)
 *
 * Bit layout on PCF8574 → HD44780:
 *  P7 P6 P5 P4  P3       P2    P1    P0
 *  D7 D6 D5 D4  BL(HIGH) EN    RW(0) RS
 * ══════════════════════════════════════════════════════════════════════════════ */
static void LCD_I2C_Write(uint8_t data)
{
    HAL_I2C_Master_Transmit(&hi2c1, LCD_ADDR, &data, 1, HAL_MAX_DELAY);
}

static void LCD_Pulse_Enable(uint8_t data)
{
    LCD_I2C_Write(data | LCD_EN);
    HAL_Delay(1);
    LCD_I2C_Write(data & ~LCD_EN);
    HAL_Delay(1);
}

static void LCD_Send4(uint8_t data, uint8_t mode)
{
    uint8_t hi = (data & 0xF0) | LCD_BACKLIGHT | mode;
    uint8_t lo = ((data << 4) & 0xF0) | LCD_BACKLIGHT | mode;
    LCD_Pulse_Enable(hi);
    LCD_Pulse_Enable(lo);
}

static void LCD_SendCmd(uint8_t cmd)  { LCD_Send4(cmd, 0); }
static void LCD_SendData(uint8_t d)   { LCD_Send4(d, LCD_RS); }

static void LCD_Init(void)
{
    HAL_Delay(50);
    /* Initialise in 4-bit mode per HD44780 datasheet */
    LCD_I2C_Write(LCD_BACKLIGHT);
    HAL_Delay(100);

    LCD_Pulse_Enable(0x30 | LCD_BACKLIGHT);  HAL_Delay(5);
    LCD_Pulse_Enable(0x30 | LCD_BACKLIGHT);  HAL_Delay(1);
    LCD_Pulse_Enable(0x30 | LCD_BACKLIGHT);  HAL_Delay(1);
    LCD_Pulse_Enable(0x20 | LCD_BACKLIGHT);  HAL_Delay(1);

    LCD_SendCmd(0x28);  /* 4-bit, 2 lines, 5×8 dots */
    LCD_SendCmd(0x0C);  /* display on, cursor off     */
    LCD_SendCmd(0x06);  /* entry mode: increment       */
    LCD_SendCmd(0x01);  /* clear display               */
    HAL_Delay(2);
}

static void LCD_SetCursor(uint8_t col, uint8_t row)
{
    uint8_t addr = (row == 0) ? (0x80 + col) : (0xC0 + col);
    LCD_SendCmd(addr);
}

static void LCD_Print(const char *str)
{
    while (*str) LCD_SendData((uint8_t)*str++);
}

/* ══════════════════════════════════════════════════════════════════════════════
 * LCD screen layout
 *
 *  Row 0: "V:11.52V  S:74.6%"    (voltage + SOC)
 *  Row 1: "I: 2.84A  T:33.1C"    (current + temperature)
 *
 *  On fault, row 1 shows the most critical fault message.
 * ══════════════════════════════════════════════════════════════════════════════ */
static void LCD_Update(float voltage, float current, float temp, float soc,
                        FaultFlags f, uint8_t charging)
{
    char row0[17], row1[17];

    snprintf(row0, sizeof(row0), "V:%5.2fV S:%4.1f%%", (double)voltage, (double)soc);

    if (f.fire) {
        snprintf(row1, sizeof(row1), "  FIRE DETECTED ");
    } else if (f.over_voltage) {
        snprintf(row1, sizeof(row1), " OVER-VOLTAGE!  ");
    } else if (f.under_voltage) {
        snprintf(row1, sizeof(row1), " UNDER-VOLTAGE! ");
    } else if (f.over_current) {
        snprintf(row1, sizeof(row1), " OVER-CURRENT!  ");
    } else if (f.over_temp) {
        snprintf(row1, sizeof(row1), " OVER-TEMP!     ");
    } else if (f.low_battery) {
        snprintf(row1, sizeof(row1), " LOW BATTERY!   ");
    } else if (charging) {
        snprintf(row1, sizeof(row1), "I:%5.2fA CHRGNG", (double)current);
    } else {
        snprintf(row1, sizeof(row1), "I:%5.2fA T:%4.1fC", (double)current, (double)temp);
    }

    LCD_SetCursor(0, 0); LCD_Print(row0);
    LCD_SetCursor(0, 1); LCD_Print(row1);
}

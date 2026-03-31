/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * bundledSVDs — Minimal CMSIS-SVD XML for auto-loading on session start.
 *
 * These are trimmed (but structurally correct) SVDs covering the most-used
 * peripherals for each family. The SVDParserService will parse them exactly
 * the same way it handles user-supplied SVD files.
 *
 * Families covered:
 *   stm32f4  — STM32F401/F407/F411/F429 (Cortex-M4F)
 *   stm32f7  — STM32F746/F767 (Cortex-M7)
 *   stm32h7  — STM32H743/H750 (Cortex-M7, dual core)
 *   stm32l4  — STM32L432/L476 (ultra-low-power)
 *   stm32g4  — STM32G431/G474 (motor control)
 *   nrf52840 — Nordic nRF52840 (Cortex-M4F + 2.4 GHz)
 *   esp32    — ESP32 (Xtensa LX6 dual core)
 *   rp2040   — Raspberry Pi RP2040 (dual Cortex-M0+)
 */

/** Keys match IMCUDatabaseEntry.family (lowercase). */
export const BUNDLED_SVD_XML: Readonly<Record<string, string>> = {

// ─── STM32F4 ─────────────────────────────────────────────────────────────────
stm32f4: `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" xs:noNamespaceSchemaLocation="CMSIS-SVD.xsd">
  <vendor>STMicroelectronics</vendor>
  <vendorID>STM</vendorID>
  <name>STM32F4</name>
  <series>STM32F4</series>
  <version>1.7</version>
  <description>STM32F4 series</description>
  <cpu><name>CM4</name><revision>r0p1</revision><endian>little</endian><mpuPresent>true</mpuPresent><fpuPresent>true</fpuPresent><nvicPrioBits>4</nvicPrioBits><vendorSystickConfig>false</vendorSystickConfig></cpu>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <size>0x20</size>
  <access>read-write</access>
  <resetValue>0x00000000</resetValue>
  <resetMask>0xFFFFFFFF</resetMask>
  <peripherals>
    <peripheral>
      <name>RCC</name>
      <description>Reset and clock control</description>
      <groupName>RCC</groupName>
      <baseAddress>0x40023800</baseAddress>
      <registers>
        <register><name>CR</name><description>clock control register</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000083</resetValue><fields><field><name>HSION</name><description>Internal high-speed clock enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>HSIRDY</name><description>Internal high-speed clock ready flag</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>HSEON</name><description>HSE clock enable</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>HSERDY</name><description>HSE clock ready flag</description><bitOffset>17</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>PLLON</name><description>Main PLL enable</description><bitOffset>24</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PLLRDY</name><description>Main PLL ready</description><bitOffset>25</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>CFGR</name><description>clock configuration register</description><addressOffset>0x08</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>SW</name><description>System clock switch</description><bitOffset>0</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field><field><name>SWS</name><description>System clock switch status</description><bitOffset>2</bitOffset><bitWidth>2</bitWidth><access>read-only</access></field><field><name>HPRE</name><description>AHB prescaler</description><bitOffset>4</bitOffset><bitWidth>4</bitWidth><access>read-write</access></field><field><name>PPRE1</name><description>APB Low speed prescaler</description><bitOffset>10</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field><field><name>PPRE2</name><description>APB high-speed prescaler</description><bitOffset>13</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field></fields></register>
        <register><name>AHB1ENR</name><description>AHB1 peripheral clock register</description><addressOffset>0x30</addressOffset><size>32</size><access>read-write</access><resetValue>0x00100000</resetValue><fields><field><name>GPIOAEN</name><description>IO port A clock enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>GPIOBEN</name><description>IO port B clock enable</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>GPIOCEN</name><description>IO port C clock enable</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>DMA1EN</name><description>DMA1 clock enable</description><bitOffset>21</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>DMA2EN</name><description>DMA2 clock enable</description><bitOffset>22</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>APB1ENR</name><description>APB1 peripheral clock enable register</description><addressOffset>0x40</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>TIM2EN</name><description>TIM2 clock enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>USART2EN</name><description>USART2 clock enable</description><bitOffset>17</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>I2C1EN</name><description>I2C1 clock enable</description><bitOffset>21</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>GPIOA</name>
      <description>General-purpose I/Os</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x40020000</baseAddress>
      <registers>
        <register><name>MODER</name><description>GPIO port mode register</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0xA8000000</resetValue><fields><field><name>MODER15</name><description>Port x configuration bits y=15</description><bitOffset>30</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field><field><name>MODER0</name><description>Port x configuration bits y=0</description><bitOffset>0</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field></fields></register>
        <register><name>ODR</name><description>GPIO port output data register</description><addressOffset>0x14</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>ODR15</name><description>Port output data bit 15</description><bitOffset>15</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>ODR0</name><description>Port output data bit 0</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>BSRR</name><description>GPIO port bit set/reset register</description><addressOffset>0x18</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>BR15</name><description>Port x reset bit y=15</description><bitOffset>31</bitOffset><bitWidth>1</bitWidth><access>write-only</access></field><field><name>BS0</name><description>Port x set bit y=0</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>USART1</name>
      <description>Universal synchronous asynchronous receiver transmitter</description>
      <groupName>USART</groupName>
      <baseAddress>0x40011000</baseAddress>
      <registers>
        <register><name>SR</name><description>Status register</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x000000C0</resetValue><fields><field><name>RXNE</name><description>Read data register not empty</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>TC</name><description>Transmission complete</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>TXE</name><description>Transmit data register empty</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>DR</name><description>Data register</description><addressOffset>0x04</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>DR</name><description>Data value</description><bitOffset>0</bitOffset><bitWidth>9</bitWidth><access>read-write</access></field></fields></register>
        <register><name>BRR</name><description>Baud rate register</description><addressOffset>0x08</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>DIV_Fraction</name><description>fraction of USARTDIV</description><bitOffset>0</bitOffset><bitWidth>4</bitWidth><access>read-write</access></field><field><name>DIV_Mantissa</name><description>mantissa of USARTDIV</description><bitOffset>4</bitOffset><bitWidth>12</bitWidth><access>read-write</access></field></fields></register>
        <register><name>CR1</name><description>Control register 1</description><addressOffset>0x0C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>RE</name><description>Receiver enable</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>TE</name><description>Transmitter enable</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>RXNEIE</name><description>RXNE interrupt enable</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>TCIE</name><description>Transmission complete interrupt enable</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>UE</name><description>USART enable</description><bitOffset>13</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>SPI1</name>
      <description>Serial peripheral interface</description>
      <groupName>SPI</groupName>
      <baseAddress>0x40013000</baseAddress>
      <registers>
        <register><name>CR1</name><description>control register 1</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>CPHA</name><description>Clock phase</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>CPOL</name><description>Clock polarity</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>MSTR</name><description>Master selection</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>BR</name><description>Baud rate control</description><bitOffset>3</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field><field><name>SPE</name><description>SPI enable</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>DFF</name><description>Data frame format</description><bitOffset>11</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>SR</name><description>status register</description><addressOffset>0x08</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000002</resetValue><fields><field><name>RXNE</name><description>Receive buffer not empty</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>TXE</name><description>Transmit buffer empty</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>BSY</name><description>Busy flag</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>DR</name><description>data register</description><addressOffset>0x0C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>DR</name><description>Data register</description><bitOffset>0</bitOffset><bitWidth>16</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>I2C1</name>
      <description>Inter-integrated circuit</description>
      <groupName>I2C</groupName>
      <baseAddress>0x40005400</baseAddress>
      <registers>
        <register><name>CR1</name><description>Control register 1</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>PE</name><description>Peripheral enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>START</name><description>Start generation</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>STOP</name><description>Stop generation</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>ACK</name><description>Acknowledge enable</description><bitOffset>10</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>SR1</name><description>Status register 1</description><addressOffset>0x14</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>SB</name><description>Start bit</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>ADDR</name><description>Address sent/matched</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>TXE</name><description>Data register empty</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>RXNE</name><description>Data register not empty</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>TIM1</name>
      <description>Advanced-control timers</description>
      <groupName>TIM</groupName>
      <baseAddress>0x40010000</baseAddress>
      <registers>
        <register><name>CR1</name><description>control register 1</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>CEN</name><description>Counter enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>UDIS</name><description>Update disable</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>URS</name><description>Update request source</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>DIR</name><description>Direction</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>ARR</name><description>auto-reload register</description><addressOffset>0x2C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>ARR</name><description>Auto-reload value</description><bitOffset>0</bitOffset><bitWidth>32</bitWidth><access>read-write</access></field></fields></register>
        <register><name>PSC</name><description>prescaler</description><addressOffset>0x28</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>PSC</name><description>Prescaler value</description><bitOffset>0</bitOffset><bitWidth>16</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>ADC1</name>
      <description>Analog to digital converter</description>
      <groupName>ADC</groupName>
      <baseAddress>0x40012000</baseAddress>
      <registers>
        <register><name>SR</name><description>status register</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>EOC</name><description>Regular channel end of conversion</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>STRT</name><description>Regular channel start flag</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>CR1</name><description>control register 1</description><addressOffset>0x04</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>AWDCH</name><description>Analog watchdog channel select bits</description><bitOffset>0</bitOffset><bitWidth>5</bitWidth><access>read-write</access></field><field><name>EOCIE</name><description>Interrupt enable for EOC</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>SCAN</name><description>Scan mode</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>DR</name><description>regular data register</description><addressOffset>0x4C</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>DATA</name><description>Regular data</description><bitOffset>0</bitOffset><bitWidth>16</bitWidth><access>read-only</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>FLASH</name>
      <description>FLASH register block</description>
      <groupName>FLASH</groupName>
      <baseAddress>0x40023C00</baseAddress>
      <registers>
        <register><name>ACR</name><description>Flash access control register</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>LATENCY</name><description>Latency</description><bitOffset>0</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field><field><name>PRFTEN</name><description>Prefetch enable</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>ICEN</name><description>Instruction cache enable</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>DCEN</name><description>Data cache enable</description><bitOffset>10</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>SR</name><description>Status register</description><addressOffset>0x0C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>EOP</name><description>End of operation</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>OPERR</name><description>Operation error</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>BSY</name><description>Busy</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>CR</name><description>Control register</description><addressOffset>0x10</addressOffset><size>32</size><access>read-write</access><resetValue>0x80000000</resetValue><fields><field><name>PG</name><description>Programming</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>SER</name><description>Sector Erase</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PSIZE</name><description>Program size</description><bitOffset>8</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field><field><name>STRT</name><description>Start</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>LOCK</name><description>Lock</description><bitOffset>31</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>PWR</name>
      <description>Power control</description>
      <groupName>PWR</groupName>
      <baseAddress>0x40007000</baseAddress>
      <registers>
        <register><name>CR</name><description>power control register</description><addressOffset>0x00</addressOffset><size>32</size><access>read-write</access><resetValue>0x0000C000</resetValue><fields><field><name>LPDS</name><description>Low-power deep sleep</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PDDS</name><description>Power-down deepsleep</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>CWUF</name><description>Clear wakeup flag</description><bitOffset>2</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>VOS</name><description>Regulator voltage scaling output selection</description><bitOffset>14</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>IWDG</name>
      <description>Independent watchdog</description>
      <groupName>IWDG</groupName>
      <baseAddress>0x40003000</baseAddress>
      <registers>
        <register><name>KR</name><description>Key register</description><addressOffset>0x00</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>KEY</name><description>Key value</description><bitOffset>0</bitOffset><bitWidth>16</bitWidth><access>write-only</access></field></fields></register>
        <register><name>RLR</name><description>Reload register</description><addressOffset>0x08</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000FFF</resetValue><fields><field><name>RL</name><description>Watchdog counter reload value</description><bitOffset>0</bitOffset><bitWidth>12</bitWidth><access>read-write</access></field></fields></register>
        <register><name>SR</name><description>Status register</description><addressOffset>0x0C</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>PVU</name><description>Watchdog prescaler value update</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>RVU</name><description>Watchdog counter reload value update</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
      </registers>
    </peripheral>
  </peripherals>
</device>`,

// ─── nRF52840 ─────────────────────────────────────────────────────────────────
nrf52840: `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" xs:noNamespaceSchemaLocation="CMSIS-SVD.xsd">
  <vendor>Nordic Semiconductor</vendor>
  <vendorID>Nordic</vendorID>
  <name>nRF52840</name>
  <series>nRF52</series>
  <version>1.0</version>
  <description>nRF52840 product specification v1.7</description>
  <cpu><name>CM4</name><revision>r0p1</revision><endian>little</endian><mpuPresent>true</mpuPresent><fpuPresent>true</fpuPresent><nvicPrioBits>3</nvicPrioBits><vendorSystickConfig>false</vendorSystickConfig></cpu>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <peripherals>
    <peripheral>
      <name>CLOCK</name>
      <description>Clock control</description>
      <groupName>CLOCK</groupName>
      <baseAddress>0x40000000</baseAddress>
      <registers>
        <register><name>TASKS_HFCLKSTART</name><description>Start HFXO crystal oscillator</description><addressOffset>0x000</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_HFCLKSTART</name><description>Start HFXO crystal oscillator</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access></field></fields></register>
        <register><name>EVENTS_HFCLKSTARTED</name><description>HFXO crystal oscillator started</description><addressOffset>0x100</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>EVENTS_HFCLKSTARTED</name><description>HFXO crystal oscillator started</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>HFCLKRUN</name><description>Status indicating that HFCLKSTART task has been triggered</description><addressOffset>0x408</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>STATUS</name><description>HFCLKSTART task triggered or not</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>HFCLKSTAT</name><description>HFCLK status</description><addressOffset>0x40C</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>SRC</name><description>Source of HFCLK</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>STATE</name><description>HFCLK state</description><bitOffset>16</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>GPIO0</name>
      <description>GPIO Port 0</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x50000000</baseAddress>
      <registers>
        <register><name>OUT</name><description>Write GPIO port</description><addressOffset>0x504</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>PIN0</name><description>Pin 0</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PIN1</name><description>Pin 1</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>DIR</name><description>Direction of GPIO pins</description><addressOffset>0x514</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>PIN0</name><description>Pin 0 direction</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>IN</name><description>Read GPIO port</description><addressOffset>0x510</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>PIN0</name><description>Pin 0</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>PIN_CNF0</name><description>Configuration of GPIO pins</description><addressOffset>0x700</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000002</resetValue><fields><field><name>DIR</name><description>Pin direction</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>INPUT</name><description>Connect or disconnect input buffer</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PULL</name><description>Pull configuration</description><bitOffset>2</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field><field><name>DRIVE</name><description>Drive configuration</description><bitOffset>8</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field><field><name>SENSE</name><description>Pin sensing mechanism</description><bitOffset>16</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>UARTE0</name>
      <description>UART with EasyDMA 0</description>
      <groupName>UARTE</groupName>
      <baseAddress>0x40002000</baseAddress>
      <registers>
        <register><name>TASKS_STARTRX</name><description>Start UART receiver</description><addressOffset>0x000</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_STARTRX</name><description>Start UART receiver</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access></field></fields></register>
        <register><name>TASKS_STARTTX</name><description>Start UART transmitter</description><addressOffset>0x008</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_STARTTX</name><description>Start UART transmitter</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access></field></fields></register>
        <register><name>EVENTS_ENDRX</name><description>Receive buffer is filled up</description><addressOffset>0x110</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>EVENTS_ENDRX</name><description>Receive buffer is filled up</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>CONFIG</name><description>Configuration of parity and hardware flow control</description><addressOffset>0x56C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>HWFC</name><description>Hardware flow control</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PARITY</name><description>Parity</description><bitOffset>1</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field></fields></register>
        <register><name>BAUDRATE</name><description>Baud rate</description><addressOffset>0x524</addressOffset><size>32</size><access>read-write</access><resetValue>0x04000000</resetValue><fields><field><name>BAUDRATE</name><description>Baud rate</description><bitOffset>0</bitOffset><bitWidth>32</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>RADIO</name>
      <description>2.4 GHz Radio</description>
      <groupName>RADIO</groupName>
      <baseAddress>0x40001000</baseAddress>
      <registers>
        <register><name>TASKS_TXEN</name><description>Enable RADIO in TX mode</description><addressOffset>0x000</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_TXEN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access><description>Enable RADIO in TX mode</description></field></fields></register>
        <register><name>TASKS_RXEN</name><description>Enable RADIO in RX mode</description><addressOffset>0x004</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_RXEN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access><description>Enable RADIO in RX mode</description></field></fields></register>
        <register><name>FREQUENCY</name><description>Frequency</description><addressOffset>0x508</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000002</resetValue><fields><field><name>FREQUENCY</name><description>Radio channel frequency</description><bitOffset>0</bitOffset><bitWidth>7</bitWidth><access>read-write</access></field><field><name>MAP</name><description>Channel map selection</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>TXPOWER</name><description>Output power</description><addressOffset>0x50C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>TXPOWER</name><description>RADIO output power</description><bitOffset>0</bitOffset><bitWidth>8</bitWidth><access>read-write</access></field></fields></register>
        <register><name>STATE</name><description>Current radio state</description><addressOffset>0x550</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>STATE</name><description>Current radio state</description><bitOffset>0</bitOffset><bitWidth>4</bitWidth><access>read-only</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>SAADC</name>
      <description>Successive approximation analog-to-digital converter</description>
      <groupName>SAADC</groupName>
      <baseAddress>0x40007000</baseAddress>
      <registers>
        <register><name>TASKS_START</name><description>Start the ADC and prepare the result buffer in RAM</description><addressOffset>0x000</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_START</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access><description>Start the ADC and prepare the result buffer in RAM</description></field></fields></register>
        <register><name>TASKS_SAMPLE</name><description>Take one ADC sample</description><addressOffset>0x004</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>TASKS_SAMPLE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>write-only</access><description>Take one ADC sample, if scan is enabled all channels are sampled</description></field></fields></register>
        <register><name>ENABLE</name><description>Enable or disable SAADC</description><addressOffset>0x500</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>ENABLE</name><description>Enable or disable SAADC</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>RESOLUTION</name><description>Resolution configuration</description><addressOffset>0x5F0</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000001</resetValue><fields><field><name>VAL</name><description>Set the resolution</description><bitOffset>0</bitOffset><bitWidth>3</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
  </peripherals>
</device>`,

// ─── RP2040 ───────────────────────────────────────────────────────────────────
rp2040: `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance" xs:noNamespaceSchemaLocation="CMSIS-SVD.xsd">
  <vendor>Raspberry Pi</vendor>
  <vendorID>RPI</vendorID>
  <name>RP2040</name>
  <series>RP2040</series>
  <version>1.0</version>
  <description>RP2040 microcontroller</description>
  <cpu><name>CM0PLUS</name><revision>r0p1</revision><endian>little</endian><mpuPresent>true</mpuPresent><fpuPresent>false</fpuPresent><nvicPrioBits>2</nvicPrioBits><vendorSystickConfig>false</vendorSystickConfig></cpu>
  <addressUnitBits>8</addressUnitBits><width>32</width>
  <peripherals>
    <peripheral>
      <name>SIO</name>
      <description>Single-cycle IO block — provides core-local peripherals</description>
      <groupName>SIO</groupName>
      <baseAddress>0xD0000000</baseAddress>
      <registers>
        <register><name>CPUID</name><description>Processor core identifier</description><addressOffset>0x000</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>CPUID</name><description>0 = Cortex-M0+ core 0, 1 = Cortex-M0+ core 1</description><bitOffset>0</bitOffset><bitWidth>32</bitWidth><access>read-only</access></field></fields></register>
        <register><name>GPIO_OUT</name><description>GPIO output value</description><addressOffset>0x010</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>GPIO_OUT</name><description>Set output level (1/0 → high/low) for GPIO0…29</description><bitOffset>0</bitOffset><bitWidth>30</bitWidth><access>read-write</access></field></fields></register>
        <register><name>GPIO_OE</name><description>GPIO output enable</description><addressOffset>0x020</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>GPIO_OE</name><description>Set output enable (1/0 → enable/disable) for GPIO0…29</description><bitOffset>0</bitOffset><bitWidth>30</bitWidth><access>read-write</access></field></fields></register>
        <register><name>GPIO_IN</name><description>GPIO input value</description><addressOffset>0x004</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>GPIO_IN</name><description>Input value for GPIO0…29</description><bitOffset>0</bitOffset><bitWidth>30</bitWidth><access>read-only</access></field></fields></register>
        <register><name>SPINLOCK_ST</name><description>Spinlock state</description><addressOffset>0x05C</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000000</resetValue><fields><field><name>SPINLOCK_ST</name><description>Bitmap of 32 spinlocks; 1 = locked, 0 = free</description><bitOffset>0</bitOffset><bitWidth>32</bitWidth><access>read-only</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>UART0</name>
      <description>UART0</description>
      <groupName>UART</groupName>
      <baseAddress>0x40034000</baseAddress>
      <registers>
        <register><name>UARTDR</name><description>Data Register</description><addressOffset>0x000</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>OE</name><description>Overrun error</description><bitOffset>11</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>BE</name><description>Break error</description><bitOffset>10</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>DATA</name><description>Receive / transmit data character</description><bitOffset>0</bitOffset><bitWidth>8</bitWidth><access>read-write</access></field></fields></register>
        <register><name>UARTFR</name><description>Flag Register</description><addressOffset>0x018</addressOffset><size>32</size><access>read-only</access><resetValue>0x00000090</resetValue><fields><field><name>TXFE</name><description>Transmit FIFO empty</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>RXFF</name><description>Receive FIFO full</description><bitOffset>6</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>TXFF</name><description>Transmit FIFO full</description><bitOffset>5</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>RXFE</name><description>Receive FIFO empty</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field><field><name>BUSY</name><description>UART busy</description><bitOffset>3</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
        <register><name>UARTLCR_H</name><description>Line Control Register</description><addressOffset>0x02C</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>SPS</name><description>Stick parity select</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>WLEN</name><description>Word length</description><bitOffset>5</bitOffset><bitWidth>2</bitWidth><access>read-write</access></field><field><name>FEN</name><description>Enable FIFOs</description><bitOffset>4</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>PEN</name><description>Parity enable</description><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>UARTCR</name><description>Control Register</description><addressOffset>0x030</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000300</resetValue><fields><field><name>CTSEN</name><description>CTS hardware flow control enable</description><bitOffset>15</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>TXE</name><description>Transmit enable</description><bitOffset>8</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>RXE</name><description>Receive enable</description><bitOffset>9</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>UARTEN</name><description>UART enable</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>PWM</name>
      <description>Simple PWM</description>
      <groupName>PWM</groupName>
      <baseAddress>0x40050000</baseAddress>
      <registers>
        <register><name>EN</name><description>This register aliases the CSR_EN bits for all channels</description><addressOffset>0x0A0</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>CH7</name><description>Enable PWM channel 7</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>CH0</name><description>Enable PWM channel 0</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
        <register><name>INTR</name><description>Raw Interrupts</description><addressOffset>0x0A4</addressOffset><size>32</size><access>read-write</access><resetValue>0x00000000</resetValue><fields><field><name>CH7</name><description>Channel 7 wrap interrupt</description><bitOffset>7</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>CH0</name><description>Channel 0 wrap interrupt</description><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field></fields></register>
      </registers>
    </peripheral>
    <peripheral>
      <name>WATCHDOG</name>
      <description>Watchdog timer</description>
      <groupName>WATCHDOG</groupName>
      <baseAddress>0x40058000</baseAddress>
      <registers>
        <register><name>CTRL</name><description>Watchdog control</description><addressOffset>0x000</addressOffset><size>32</size><access>read-write</access><resetValue>0x07000000</resetValue><fields><field><name>TRIGGER</name><description>Trigger a watchdog reset</description><bitOffset>31</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>ENABLE</name><description>When not enabled the watchdog timer is paused</description><bitOffset>30</bitOffset><bitWidth>1</bitWidth><access>read-write</access></field><field><name>TIME</name><description>Indicates the number of ticks / 2 since the last watchdog reset</description><bitOffset>0</bitOffset><bitWidth>24</bitWidth><access>read-only</access></field></fields></register>
        <register><name>LOAD</name><description>Load the watchdog timer</description><addressOffset>0x004</addressOffset><size>32</size><access>write-only</access><resetValue>0x00000000</resetValue><fields><field><name>LOAD</name><description>Load the watchdog timer. The maximum setting is 0xffffff which corresponds to 0xffffff / 2 ticks before triggering a watchdog reset</description><bitOffset>0</bitOffset><bitWidth>24</bitWidth><access>write-only</access></field></fields></register>
      </registers>
    </peripheral>
  </peripherals>
</device>`,

};

/**
 * Canonical family key lookup — maps MCU family strings to BUNDLED_SVD_XML keys.
 * Case-insensitive. Returns undefined if no bundled SVD is available.
 */
export function lookupBundledSVDKey(family: string): string | undefined {
	const f = family.toLowerCase().replace(/[^a-z0-9]/g, '');
	if (f.startsWith('stm32f4') || f === 'stm32f4') { return 'stm32f4'; }
	if (f.startsWith('stm32f7') || f === 'stm32f7') { return 'stm32f7'; }
	if (f.startsWith('stm32h7') || f === 'stm32h7') { return 'stm32h7'; }
	if (f.startsWith('stm32l4') || f === 'stm32l4') { return 'stm32l4'; }
	if (f.startsWith('stm32g4') || f === 'stm32g4') { return 'stm32g4'; }
	if (f.startsWith('nrf5384') || f === 'nrf52840' || f === 'nrf52') { return 'nrf52840'; }
	if (f === 'esp32' || f.startsWith('esp32')) { return 'esp32'; }
	if (f === 'rp2040' || f.startsWith('rp2040')) { return 'rp2040'; }
	return undefined;
}

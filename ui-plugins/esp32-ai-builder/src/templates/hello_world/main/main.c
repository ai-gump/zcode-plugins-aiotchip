/* esp32-ai-builder hello_world：每秒打印芯片信息并翻转 LED。
 * 引脚由 CONFIG_BLINK_GPIO 控制（sdkconfig.defaults 默认 2），按开发板实际接线修改。 */
#include <stdio.h>

#include "driver/gpio.h"
#include "esp_chip_info.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "esp32-ai-builder";

void app_main(void)
{
    esp_chip_info_t chip = {0};
    esp_chip_info(&chip);
    ESP_LOGI(TAG, "ESP-IDF v%d.%d.%d | chip %s rev v%d.%d, %d core(s), %d MHz",
             ESP_IDF_VERSION_MAJOR, ESP_IDF_VERSION_MINOR, ESP_IDF_VERSION_PATCH,
             CONFIG_IDF_TARGET, chip.revision / 100, chip.revision % 100, chip.cores,
             CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ);

    const gpio_num_t led = CONFIG_BLINK_GPIO;
    ESP_ERROR_CHECK(gpio_reset_pin(led));
    ESP_ERROR_CHECK(gpio_set_direction(led, GPIO_MODE_OUTPUT));

    for (int on = 1;; on = !on) {
        ESP_LOGI(TAG, "LED %s", on ? "on" : "off");
        ESP_ERROR_CHECK(gpio_set_level(led, on));
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

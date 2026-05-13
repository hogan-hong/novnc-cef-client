#include <node_api.h>
#include <windows.h>
#include <vector>

napi_value DrawBitmapToWindow(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  // 参数1: HWND (作为Number传入)
  uint32_t hwnd_value;
  napi_get_value_uint32(env, args[0], &hwnd_value);
  HWND hwnd = (HWND)hwnd_value;

  // 参数2: width
  uint32_t width;
  napi_get_value_uint32(env, args[1], &width);

  // 参数3: height
  uint32_t height;
  napi_get_value_uint32(env, args[2], &height);

  // 参数4: Buffer
  void* data;
  size_t length;
  napi_get_buffer_info(env, args[3], &data, &length);

  // 设置BITMAPINFO
  BITMAPINFO bmi = {0};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = width;
  bmi.bmiHeader.biHeight = -height;  // 负值表示自上而下
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  bmi.bmiHeader.biCompression = BI_RGB;

  // 获取窗口HDC并绘制
  HDC hdc = GetDC(hwnd);
  if (hdc) {
    StretchDIBits(hdc,
      0, 0, width, height,  // 目标区域
      0, 0, width, height,  // 源区域
      data,
      &bmi,
      DIB_RGB_COLORS,
      SRCCOPY
    );
    ReleaseDC(hwnd, hdc);
  }

  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"drawBitmapToWindow", nullptr, DrawBitmapToWindow, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 1, desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
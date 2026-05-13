#include <nan.h>
#include <windows.h>

using namespace Nan;

// 绘制位图到指定窗口
NAN_METHOD(DrawBitmapToWindow) {
  if (info.Length() < 4) {
    Nan::ThrowTypeError("Wrong number of arguments");
    return;
  }

  HWND hwnd = reinterpret_cast<HWND>(info[0].As<Uint32>()->Value());
  uint32_t width = info[1].As<Uint32>()->Value();
  uint32_t height = info[2].As<Uint32>()->Value();
  v8::Local<v8::Object> buffer = info[3].As<v8::Object>();

  if (!node::Buffer::HasInstance(buffer)) {
    Nan::ThrowTypeError("Argument 3 must be a Buffer");
    return;
  }

  uint8_t* data = reinterpret_cast<uint8_t*>(node::Buffer::Data(buffer));
  size_t len = node::Buffer::Length(buffer);

  // 创建位图信息头
  BITMAPINFO bmi = {0};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = width;
  bmi.bmiHeader.biHeight = -height; // 负值表示从上到下
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32; // BGRA格式
  bmi.bmiHeader.biCompression = BI_RGB;
  bmi.bmiHeader.biSizeImage = len;

  // 获取窗口DC并绘制
  HDC hdc = GetDC(hwnd);
  if (hdc) {
    StretchDIBits(hdc, 0, 0, width, height, 0, 0, width, height,
                  data, &bmi, DIB_RGB_COLORS, SRCCOPY);
    ReleaseDC(hwnd, hdc);
  }

  info.GetReturnValue().Set(Nan::True());
}

// 模块初始化
NAN_MODULE_INIT(InitModule) {
  Nan::Set(target, Nan::New("drawBitmapToWindow").ToLocalChecked(),
            Nan::New<FunctionTemplate>(DrawBitmapToWindow)->GetFunction());
}

NODE_MODULE(osr_helper, InitModule)
{
  "targets": [
    {
      "target_name": "osr_helper",
      "sources": ["native/src/osr_helper.cc"],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "libraries": [
        "-lgdi32.lib"
      ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 0
            }
          }
        }]
      ]
    }
  ]
}
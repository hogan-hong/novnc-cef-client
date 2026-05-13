{
  "targets": [
    {
      "target_name": "osr_helper",
      "sources": [ "src/osr_helper.cc" ],
      "include_dirs": [
        "<!(node -e \"console.log(require('nan').include_dir)\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [ "-lgdi32.lib", "-luser32.lib" ]
        }]
      ]
    }
  ]
}
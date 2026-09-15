cmake_minimum_required(VERSION 3.29)
include("${CMAKE_CURRENT_LIST_DIR}/bootstrap-common.cmake")
fetch_checked(
  "https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip"
  "${DP_ROOT}/.deps/downloads/onnxruntime.zip"
  "0b38df9af21834e41e73d602d90db5cb06dbd1ca618948b8f1d66d607ac9f3cd")
fetch_checked(
  "https://github.com/opencv/opencv/archive/refs/tags/4.10.0.zip"
  "${DP_ROOT}/.deps/downloads/opencv.zip"
  "3810bca2b1d1c572912df0ac3888126341f3762dfd28e91068c805fb656d0e51")
fetch_checked(
  "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx"
  "${DP_ROOT}/models/ocr/det.onnx"
  "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9")
fetch_checked(
  "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx"
  "${DP_ROOT}/models/ocr/rec.onnx"
  "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b")
file(ARCHIVE_EXTRACT INPUT "${DP_ROOT}/.deps/downloads/onnxruntime.zip" DESTINATION "${DP_ROOT}/.deps")
if(NOT EXISTS "${DP_ROOT}/.deps/opencv-4.10.0/CMakeLists.txt")
  file(ARCHIVE_EXTRACT INPUT "${DP_ROOT}/.deps/downloads/opencv.zip" DESTINATION "${DP_ROOT}/.deps")
endif()
execute_process(COMMAND "${CMAKE_COMMAND}" -S "${DP_ROOT}/.deps/opencv-4.10.0" -B "${DP_ROOT}/.deps/opencv-build"
  -G "Visual Studio 17 2022" -A x64 "-DBUILD_LIST=core,imgproc" -DBUILD_SHARED_LIBS=ON
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_opencv_apps=OFF
  -DBUILD_opencv_python2=OFF -DBUILD_opencv_python3=OFF -DOPENCV_PYTHON_SKIP_DETECTION=ON
  -DWITH_IPP=OFF -DWITH_ITT=OFF -DWITH_OPENCL=OFF -DWITH_FFMPEG=OFF -DWITH_PROTOBUF=OFF
  -DCPU_DISPATCH= -DCMAKE_CONFIGURATION_TYPES=Release
  COMMAND_ERROR_IS_FATAL ANY)
execute_process(COMMAND "${CMAKE_COMMAND}" --build "${DP_ROOT}/.deps/opencv-build" --config Release --parallel 6
  COMMAND_ERROR_IS_FATAL ANY)
message(STATUS "Native OCR dependencies ready. Python detection and bindings disabled.")

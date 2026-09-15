cmake_minimum_required(VERSION 3.29)
include("${CMAKE_CURRENT_LIST_DIR}/bootstrap-common.cmake")
file(MAKE_DIRECTORY "${DP_ROOT}/.deps/downloads" "${DP_ROOT}/models/icon_detect_v3")
fetch_checked(
  "https://download.pytorch.org/libtorch/cpu/libtorch-win-shared-with-deps-2.9.1%2Bcpu.zip"
  "${DP_ROOT}/.deps/downloads/libtorch.zip"
  "d97df5305942160020067b553243fc2845b83549a6fec27c7fdb7957a9aa4a23")
fetch_checked(
  "https://huggingface.co/microsoft/OmniParser-v2.0/resolve/ef77ffa0da68a824fd59a2d11215e2862b07b5e9/icon_detect_v3/model.pt"
  "${DP_ROOT}/models/icon_detect_v3/model.pt"
  "11c6cbb77f22569fab22d86c76407a83ec81ab89dbfe28279854822d6e3fb00c")
message(STATUS "Extracting verified native runtime")
file(ARCHIVE_EXTRACT INPUT "${DP_ROOT}/.deps/downloads/libtorch.zip" DESTINATION "${DP_ROOT}/.deps")
message(STATUS "Ready. No Python installation or conversion was used.")

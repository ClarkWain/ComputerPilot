#include <desktop_pilot/core.hpp>

#include <iostream>
#include <fstream>
#include <desktop_pilot/platform.hpp>
using namespace dp;
int main(){try{
 auto check=[](bool b,const char* m){if(!b)throw std::runtime_error(m);};
 Image large{3840,2160,std::vector<uint8_t>(3840*2160*3,255)};
 auto thumbnail=resize_image(large,1600);
 check(thumbnail.width==1600&&thumbnail.height==900,"4K size cap or aspect ratio wrong");
 auto small=make_fixture();check(resize_image(small,1600).rgb==small.rgb,"small screenshots must not upscale");
 auto dir=std::filesystem::temp_directory_path()/(L"dp-image-tests-"+std::to_wstring(dp::process_id()));std::filesystem::create_directories(dir);
 save_png(small,dir/L"test.png");
 check(load_image(dir/L"test.png").rgb==small.rgb,"PNG roundtrip");
 if(webp_available()){
  save_webp(small,dir/L"lossless.webp",true);auto restored=load_image(dir/L"lossless.webp");
  check(restored.rgb==small.rgb,"lossless WebP pixel mismatch");
  save_webp(thumbnail,dir/L"preview.webp");restored=load_image(dir/L"preview.webp");
  check(restored.width==1600&&restored.height==900,"WebP dimensions");
 }
 std::filesystem::remove_all(dir);std::cout<<"PASS image sizing and codec\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

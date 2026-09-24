#include <desktop_pilot/core.hpp>
#include <windows.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <cmath>
#ifdef DP_WITH_WEBP
#include <webp/encode.h>
#include <webp/decode.h>
#endif

namespace dp {
using Microsoft::WRL::ComPtr;
static void check(HRESULT hr) { if(FAILED(hr)) { std::ostringstream s; s<<"Windows API failure 0x"<<std::hex<<uint32_t(hr); throw std::runtime_error(s.str()); } }
struct Apartment {
    HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
    Apartment() { if(hr != RPC_E_CHANGED_MODE) check(hr); }
    ~Apartment() { if(SUCCEEDED(hr)) CoUninitialize(); }
};
static ComPtr<IWICImagingFactory> factory() {
    ComPtr<IWICImagingFactory> p;
    check(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&p)));
    return p;
}
std::string utf8(std::wstring_view s) {
    if(s.empty()) return {};
    int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0,nullptr,nullptr);
    if(n<=0) throw std::runtime_error("Invalid UTF-16 string");
    std::string out(n,'\0');
    if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),int(s.size()),out.data(),n,nullptr,nullptr)) throw std::runtime_error("UTF-8 conversion failed");
    return out;
}
Image load_image(const std::filesystem::path& path) {
#ifdef DP_WITH_WEBP
    if(path.extension()==L".webp") {
        std::ifstream file(path,std::ios::binary);
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),{});
        int w=0,h=0;
        if(!WebPGetInfo(bytes.data(),bytes.size(),&w,&h)||int64_t(w)*h>64000000)throw std::runtime_error("Invalid WebP image");
        Image image{w,h,std::vector<uint8_t>(size_t(w)*h*3)};
        if(!WebPDecodeRGBInto(bytes.data(),bytes.size(),image.rgb.data(),image.rgb.size(),w*3))throw std::runtime_error("WebP decode failed");
        return image;
    }
#endif
    Apartment apt; auto f=factory(); ComPtr<IWICBitmapDecoder> decoder;
    check(f->CreateDecoderFromFilename(path.c_str(),nullptr,GENERIC_READ,WICDecodeMetadataCacheOnDemand,&decoder));
    ComPtr<IWICBitmapFrameDecode> frame; check(decoder->GetFrame(0,&frame));
    UINT w=0,h=0; check(frame->GetSize(&w,&h));
    if(!w || !h || uint64_t(w)*h>64000000ULL) throw std::runtime_error("Image exceeds 64 million pixels or is empty");
    ComPtr<IWICFormatConverter> converter; check(f->CreateFormatConverter(&converter));
    check(converter->Initialize(frame.Get(),GUID_WICPixelFormat24bppRGB,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom));
    Image image{int(w),int(h),std::vector<uint8_t>(size_t(w)*h*3)};
    check(converter->CopyPixels(nullptr,w*3,UINT(image.rgb.size()),image.rgb.data()));
    return image;
}
bool webp_available() {
#ifdef DP_WITH_WEBP
    return true;
#else
    return false;
#endif
}
void save_webp(const Image& image,const std::filesystem::path& path,bool lossless) {
    image.validate();
#ifdef DP_WITH_WEBP
    uint8_t* bytes=nullptr;
    const size_t size=lossless?WebPEncodeLosslessRGB(image.rgb.data(),image.width,image.height,image.width*3,&bytes):
        WebPEncodeRGB(image.rgb.data(),image.width,image.height,image.width*3,85,&bytes);
    if(!size)throw std::runtime_error("WebP encode failed");
    struct Guard {uint8_t* p;~Guard(){WebPFree(p);}} guard{bytes};
    if(!path.parent_path().empty())std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path,std::ios::binary);file.write(reinterpret_cast<const char*>(bytes),size);
    if(!file)throw std::runtime_error("WebP write failed");
#else
    throw std::runtime_error("WebP is disabled in this build; use PNG");
#endif
}
Image resize_image(const Image& image,int max_edge) {
    image.validate();if(max_edge<1)throw std::invalid_argument("max_edge must be positive");
    if(std::max(image.width,image.height)<=max_edge)return image;
    const double scale=double(max_edge)/std::max(image.width,image.height);
    const int w=std::max(1,int(std::lround(image.width*scale))),h=std::max(1,int(std::lround(image.height*scale)));
    Apartment apt;auto f=factory();ComPtr<IWICBitmap> bitmap;
    check(f->CreateBitmapFromMemory(image.width,image.height,GUID_WICPixelFormat24bppRGB,image.width*3,UINT(image.rgb.size()),const_cast<BYTE*>(image.rgb.data()),&bitmap));
    ComPtr<IWICBitmapScaler> scaler;check(f->CreateBitmapScaler(&scaler));
    check(scaler->Initialize(bitmap.Get(),w,h,WICBitmapInterpolationModeFant));
    Image result{w,h,std::vector<uint8_t>(size_t(w)*h*3)};
    check(scaler->CopyPixels(nullptr,w*3,UINT(result.rgb.size()),result.rgb.data()));return result;
}
void save_png(const Image& image,const std::filesystem::path& path) {
    image.validate();
    if(!path.parent_path().empty()) std::filesystem::create_directories(path.parent_path());
    Apartment apt; auto f=factory(); ComPtr<IWICStream> stream;
    check(f->CreateStream(&stream)); check(stream->InitializeFromFilename(path.c_str(),GENERIC_WRITE));
    ComPtr<IWICBitmapEncoder> encoder; check(f->CreateEncoder(GUID_ContainerFormatPng,nullptr,&encoder));
    check(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache));
    ComPtr<IWICBitmapFrameEncode> frame; check(encoder->CreateNewFrame(&frame,nullptr));
    check(frame->Initialize(nullptr)); check(frame->SetSize(image.width,image.height));
    WICPixelFormatGUID format=GUID_WICPixelFormat24bppBGR; check(frame->SetPixelFormat(&format));
    if(format!=GUID_WICPixelFormat24bppBGR) throw std::runtime_error("PNG BGR format unsupported");
    auto bgr=image.rgb;
    for(size_t i=0;i<bgr.size();i+=3) std::swap(bgr[i],bgr[i+2]);
    check(frame->WritePixels(image.height,image.width*3,UINT(bgr.size()),bgr.data()));
    check(frame->Commit()); check(encoder->Commit());
}
std::string file_sha256(const std::filesystem::path& path) {
    struct Hash {
        BCRYPT_ALG_HANDLE algorithm=nullptr; BCRYPT_HASH_HANDLE hash=nullptr;
        ~Hash(){ if(hash) BCryptDestroyHash(hash); if(algorithm) BCryptCloseAlgorithmProvider(algorithm,0); }
    } state;
    auto ok=[](NTSTATUS s){if(s<0) throw std::runtime_error("SHA-256 operation failed");};
    ok(BCryptOpenAlgorithmProvider(&state.algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0));
    ok(BCryptCreateHash(state.algorithm,&state.hash,nullptr,0,nullptr,0,0));
    std::ifstream file(path,std::ios::binary); if(!file) throw std::runtime_error("Cannot open file for SHA-256");
    std::array<char,65536> buffer;
    while(file.read(buffer.data(),buffer.size()) || file.gcount()) ok(BCryptHashData(state.hash,reinterpret_cast<PUCHAR>(buffer.data()),ULONG(file.gcount()),0));
    if(!file.eof()) throw std::runtime_error("Read failure while hashing file");
    std::array<unsigned char,32> bytes; ok(BCryptFinishHash(state.hash,bytes.data(),ULONG(bytes.size()),0));
    std::ostringstream out; for(auto b:bytes) out<<std::hex<<std::setw(2)<<std::setfill('0')<<int(b); return out.str();
}
}

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
class Canvas {
    HDC dc_=nullptr; HBITMAP bitmap_=nullptr; HGDIOBJ old_=nullptr; uint8_t* pixels_=nullptr;
    int w_,h_;
public:
    explicit Canvas(const Image& image):w_(image.width),h_(image.height) {
        image.validate(); dc_=CreateCompatibleDC(nullptr);
        if(!dc_) throw std::runtime_error("CreateCompatibleDC failed");
        BITMAPINFO info{}; info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth=w_;
        info.bmiHeader.biHeight=-h_; info.bmiHeader.biPlanes=1; info.bmiHeader.biBitCount=32; info.bmiHeader.biCompression=BI_RGB;
        bitmap_=CreateDIBSection(dc_,&info,DIB_RGB_COLORS,reinterpret_cast<void**>(&pixels_),nullptr,0);
        if(!bitmap_) { DeleteDC(dc_); throw std::runtime_error("CreateDIBSection failed"); }
        old_=SelectObject(dc_,bitmap_);
        for(size_t i=0;i<size_t(w_)*h_;++i) { pixels_[i*4]=image.rgb[i*3+2]; pixels_[i*4+1]=image.rgb[i*3+1]; pixels_[i*4+2]=image.rgb[i*3]; pixels_[i*4+3]=255; }
        SetBkMode(dc_,TRANSPARENT);
    }
    ~Canvas(){ SelectObject(dc_,old_); DeleteObject(bitmap_); DeleteDC(dc_); }
    void rect(int x,int y,int w,int h,COLORREF color,bool fill=false) {
        HPEN pen=CreatePen(PS_SOLID,2,color); HGDIOBJ op=SelectObject(dc_,pen);
        HBRUSH brush=fill?CreateSolidBrush(color):nullptr;
        HGDIOBJ ob=SelectObject(dc_,fill?brush:GetStockObject(NULL_BRUSH));
        Rectangle(dc_,x,y,x+w,y+h); SelectObject(dc_,ob); SelectObject(dc_,op);
        if(brush) DeleteObject(brush); DeleteObject(pen);
    }
    void text(int x,int y,std::wstring_view label,int size,COLORREF color) {
        HFONT font=CreateFontW(-size,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,ANTIALIASED_QUALITY,DEFAULT_PITCH,L"Segoe UI");
        HGDIOBJ old=SelectObject(dc_,font); SetTextColor(dc_,color);
        TextOutW(dc_,x,y,label.data(),int(label.size())); SelectObject(dc_,old); DeleteObject(font);
    }
    Image image() const {
        Image result{w_,h_,std::vector<uint8_t>(size_t(w_)*h_*3)};
        GdiFlush();
        for(size_t i=0;i<size_t(w_)*h_;++i){result.rgb[i*3]=pixels_[i*4+2];result.rgb[i*3+1]=pixels_[i*4+1];result.rgb[i*3+2]=pixels_[i*4];}
        return result;
    }
};
Image draw_overlay(const Image& image,std::span<const Detection> items) {
    Canvas c(image);
    for(size_t i=0;i<items.size();++i) {
        auto b=items[i].box; int x=int(b.x1),y=int(b.y1);
        c.rect(x,y,int(b.x2-b.x1),int(b.y2-b.y1),RGB(0,160,105));
        auto label=std::to_wstring(i+1); int label_y=std::max(0,y-21);
        c.rect(x,label_y,int(label.size())*11+8,21,RGB(0,100,70),true);
        c.text(x+3,label_y+1,label,16,RGB(255,255,255));
    }
    return c.image();
}
Image make_fixture() {
    Image image{960,640,std::vector<uint8_t>(960*640*3,246)}; Canvas c(image);
    c.rect(0,0,960,60,RGB(27,35,50),true); c.text(26,17,L"DesktopPilot / Local UI Fixture",23,RGB(255,255,255));
    c.text(54,92,L"Create a song",32,RGB(25,30,45)); c.text(54,149,L"Title / 歌曲标题",19,RGB(65,70,85));
    c.rect(54,180,600,46,RGB(150,160,175)); c.text(68,190,L"Evening train / 晚班列车",20,RGB(30,40,55));
    c.text(54,251,L"Lyrics / 歌词",19,RGB(65,70,85)); c.rect(54,283,600,168,RGB(150,160,175));
    c.text(70,301,L"[Verse]",20,RGB(40,50,65)); c.text(70,339,L"车窗倒映着沿途的灯火",22,RGB(40,50,65));
    c.rect(54,488,176,48,RGB(0,110,210),true); c.text(93,500,L"Create",22,RGB(255,255,255));
    c.rect(254,488,176,48,RGB(110,120,140)); c.text(297,500,L"Cancel",22,RGB(35,45,60));
    c.rect(705,180,190,46,RGB(150,160,175)); c.text(723,193,L"Advanced   v",18,RGB(40,50,65));
    c.text(55,581,L"Synthetic test image. No browser or external service is operated.",17,RGB(80,90,105));
    return c.image();
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

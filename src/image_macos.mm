#include <desktop_pilot/core.hpp>
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#include <CommonCrypto/CommonDigest.h>
#include <codecvt>
#include <locale>
#include <fstream>
#include <array>
#include <iomanip>
#include <sstream>
#include <cmath>
#ifdef DP_WITH_WEBP
#include <webp/encode.h>
#include <webp/decode.h>
#endif

namespace dp {
std::string utf8(std::wstring_view text) {
    if(text.empty())return {};
    return std::wstring_convert<std::codecvt_utf8<wchar_t>>{}.to_bytes(text.data(),text.data()+text.size());
}
namespace {
struct Canvas {
    std::vector<uint8_t> pixels;
    CGContextRef context=nullptr;
    int width,height;
    explicit Canvas(const Image& image):width(image.width),height(image.height) {
        image.validate();pixels.resize(size_t(width)*height*4);
        for(size_t i=0;i<image.rgb.size()/3;++i){for(int j=0;j<3;++j)pixels[i*4+j]=image.rgb[i*3+j];pixels[i*4+3]=255;}
        auto space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        context=CGBitmapContextCreate(pixels.data(),width,height,8,width*4,space,CGBitmapInfo(kCGImageAlphaPremultipliedLast)|kCGBitmapByteOrder32Big);
        CGColorSpaceRelease(space);if(!context)throw std::runtime_error("Cannot create image context");
        CGContextTranslateCTM(context,0,height);CGContextScaleCTM(context,1,-1);
    }
    ~Canvas(){CGContextRelease(context);}
    Image image() const {
        Image result{width,height,std::vector<uint8_t>(size_t(width)*height*3)};
        for(size_t i=0;i<result.rgb.size()/3;++i)for(int j=0;j<3;++j)result.rgb[i*3+j]=pixels[i*4+j];
        return result;
    }
    void rect(int x,int y,int w,int h,int r,int g,int b,bool fill=false) {
        CGContextSetRGBStrokeColor(context,r/255.,g/255.,b/255.,1);CGContextSetRGBFillColor(context,r/255.,g/255.,b/255.,1);
        CGContextSetLineWidth(context,2);
        if(fill)CGContextFillRect(context,CGRectMake(x,y,w,h));else CGContextStrokeRect(context,CGRectMake(x,y,w,h));
    }
    void text(int x,int y,NSString* text,int size,NSColor* color) {
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithCGContext:context flipped:YES]];
        [text drawAtPoint:NSMakePoint(x,y) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:size],NSForegroundColorAttributeName:color}];
        [NSGraphicsContext restoreGraphicsState];
    }
};
Image decode(CGImageRef cg) {
    auto w=CGImageGetWidth(cg),h=CGImageGetHeight(cg);
    if(!w||!h||w>64000000/h)throw std::runtime_error("Image exceeds 64 million pixels or is empty");
    Canvas canvas(Image{int(w),int(h),std::vector<uint8_t>(w*h*3)});
    // Image data has a top-left origin; cancel the drawing transform for CGImage.
    CGContextTranslateCTM(canvas.context,0,h);CGContextScaleCTM(canvas.context,1,-1);
    CGContextDrawImage(canvas.context,CGRectMake(0,0,w,h),cg);return canvas.image();
}
}
Image load_image(const std::filesystem::path& path) {
    @autoreleasepool {
#ifdef DP_WITH_WEBP
        if(path.extension()==".webp") {
            std::ifstream file(path,std::ios::binary);std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),{});
            int w=0,h=0;if(!WebPGetInfo(bytes.data(),bytes.size(),&w,&h)||int64_t(w)*h>64000000)throw std::runtime_error("Invalid WebP image");
            Image image{w,h,std::vector<uint8_t>(size_t(w)*h*3)};
            if(!WebPDecodeRGBInto(bytes.data(),bytes.size(),image.rgb.data(),image.rgb.size(),w*3))throw std::runtime_error("WebP decode failed");return image;
        }
#endif
        NSURL* url=[NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
        auto source=CGImageSourceCreateWithURL((__bridge CFURLRef)url,nullptr);
        if(!source)throw std::runtime_error("Cannot open image: "+path.string());
        NSDictionary* properties=CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source,0,nullptr));
        auto width=[properties[(__bridge NSString*)kCGImagePropertyPixelWidth] unsignedLongLongValue];
        auto height=[properties[(__bridge NSString*)kCGImagePropertyPixelHeight] unsignedLongLongValue];
        if(!width||!height||width>64000000/height){CFRelease(source);throw std::runtime_error("Image exceeds 64 million pixels or is empty");}
        auto cg=CGImageSourceCreateImageAtIndex(source,0,nullptr);CFRelease(source);
        if(!cg)throw std::runtime_error("Cannot decode image");
        try{auto result=decode(cg);CGImageRelease(cg);return result;}catch(...){CGImageRelease(cg);throw;}
    }
}
void save_png(const Image& image,const std::filesystem::path& path) {
    @autoreleasepool {
        Canvas canvas(image);auto cg=CGBitmapContextCreateImage(canvas.context);
        if(!path.parent_path().empty())std::filesystem::create_directories(path.parent_path());
        NSURL* url=[NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
        auto dest=CGImageDestinationCreateWithURL((__bridge CFURLRef)url,CFSTR("public.png"),1,nullptr);
        if(!dest){CGImageRelease(cg);throw std::runtime_error("Cannot create PNG output");}
        CGImageDestinationAddImage(dest,cg,nullptr);bool ok=CGImageDestinationFinalize(dest);CFRelease(dest);CGImageRelease(cg);
        if(!ok)throw std::runtime_error("PNG write failed");
    }
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
    size_t size=lossless?WebPEncodeLosslessRGB(image.rgb.data(),image.width,image.height,image.width*3,&bytes):WebPEncodeRGB(image.rgb.data(),image.width,image.height,image.width*3,85,&bytes);
    if(!size)throw std::runtime_error("WebP encode failed");
    struct Guard{uint8_t* p;~Guard(){WebPFree(p);}} guard{bytes};
    if(!path.parent_path().empty())std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path,std::ios::binary);file.write(reinterpret_cast<const char*>(bytes),size);if(!file)throw std::runtime_error("WebP write failed");
#else
    throw std::runtime_error("WebP is disabled in this build; use PNG");
#endif
}
Image resize_image(const Image& image,int max_edge) {
    image.validate();if(max_edge<1)throw std::invalid_argument("max_edge must be positive");
    if(std::max(image.width,image.height)<=max_edge)return image;
    double scale=double(max_edge)/std::max(image.width,image.height);
    int w=std::max(1,int(std::lround(image.width*scale))),h=std::max(1,int(std::lround(image.height*scale)));
    Canvas source(image),dest(Image{w,h,std::vector<uint8_t>(size_t(w)*h*3)});
    auto cg=CGBitmapContextCreateImage(source.context);CGContextTranslateCTM(dest.context,0,h);CGContextScaleCTM(dest.context,1,-1);
    CGContextSetInterpolationQuality(dest.context,kCGInterpolationHigh);CGContextDrawImage(dest.context,CGRectMake(0,0,w,h),cg);CGImageRelease(cg);return dest.image();
}
Image draw_overlay(const Image& image,std::span<const Detection> items) {
    @autoreleasepool {
        Canvas c(image);
        for(size_t i=0;i<items.size();++i){auto b=items[i].box;int x=b.x1,y=b.y1,ly=std::max(0,y-21);
            c.rect(x,y,b.x2-b.x1,b.y2-b.y1,0,160,105);auto label=[NSString stringWithFormat:@"%zu",i+1];
            c.rect(x,ly,int(label.length)*11+8,21,0,100,70,true);c.text(x+3,ly+1,label,16,NSColor.whiteColor);}
        return c.image();
    }
}
Image make_fixture() {
    @autoreleasepool {
        Canvas c(Image{960,640,std::vector<uint8_t>(960*640*3,246)});
        c.rect(0,0,960,60,27,35,50,true);c.text(26,17,@"ComputerPilot / Local UI Fixture",23,NSColor.whiteColor);
        c.text(54,92,@"Create a song",32,NSColor.blackColor);c.text(54,149,@"Title / 歌曲标题",19,NSColor.darkGrayColor);
        c.rect(54,180,600,46,150,160,175);c.text(68,190,@"Evening train / 晚班列车",20,NSColor.blackColor);
        c.text(54,251,@"Lyrics / 歌词",19,NSColor.darkGrayColor);c.rect(54,283,600,168,150,160,175);
        c.text(70,301,@"[Verse]",20,NSColor.darkGrayColor);c.text(70,339,@"车窗倒映着沿途的灯火",22,NSColor.darkGrayColor);
        c.rect(54,488,176,48,0,110,210,true);c.text(93,500,@"Create",22,NSColor.whiteColor);
        c.rect(254,488,176,48,110,120,140);c.text(297,500,@"Cancel",22,NSColor.darkGrayColor);
        c.rect(705,180,190,46,150,160,175);c.text(723,193,@"Advanced   v",18,NSColor.darkGrayColor);
        c.text(55,581,@"Synthetic test image. No browser or external service is operated.",17,NSColor.darkGrayColor);return c.image();
    }
}
std::string file_sha256(const std::filesystem::path& path) {
    std::ifstream file(path,std::ios::binary);if(!file)throw std::runtime_error("Cannot open file for SHA-256");
    CC_SHA256_CTX ctx;CC_SHA256_Init(&ctx);std::array<char,65536> buffer;
    while(file.read(buffer.data(),buffer.size())||file.gcount())CC_SHA256_Update(&ctx,buffer.data(),CC_LONG(file.gcount()));
    if(!file.eof())throw std::runtime_error("Read failure while hashing file");
    std::array<unsigned char,32> bytes;CC_SHA256_Final(bytes.data(),&ctx);
    std::ostringstream out;for(auto b:bytes)out<<std::hex<<std::setw(2)<<std::setfill('0')<<int(b);return out.str();
}
}

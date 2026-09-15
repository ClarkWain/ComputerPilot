#include <desktop_pilot/ocr.hpp>
#include <iostream>
#include <limits>
#include <stdexcept>
static int checks=0;
static void require(bool v,const char* why){++checks;if(!v)throw std::runtime_error(why);}
int main(){
    using namespace dp;
    try {
        std::vector<std::string> dict={"","你","好"," "};
        std::vector<int> sequence={1,1,0,1,2,2,3};std::vector<float> probs(sequence.size()*dict.size(),0);
        for(size_t i=0;i<sequence.size();++i)probs[i*dict.size()+sequence[i]]=0.9f;
        auto decoded=decode_ctc(probs,sequence.size(),dict);
        require(decoded.text=="你你好 ","CTC collapse and blank separation");
        require(decoded.confidence>0.89f&&decoded.confidence<0.91f,"CTC confidence");
        bool mismatch=false;try{decode_ctc(probs,1,dict);}catch(const std::invalid_argument&){mismatch=true;}require(mismatch,"dictionary shape mismatch rejected");
        probs[0]=std::numeric_limits<float>::quiet_NaN();bool invalid=false;try{decode_ctc(probs,sequence.size(),dict);}catch(const std::runtime_error&){invalid=true;}require(invalid,"nonfinite output rejected");
        std::vector<Detection> regions={{{0,0,300,300},0.9f,0},{{20,20,120,70},0.8f,0}};
        TextLine create;create.box={30,30,100,55};create.text="Create";create.score=0.98f;
        TextLine loose;loose.box={310,10,390,40};loose.text="外部文字";loose.score=0.9f;
        auto fused=fuse_text(regions,std::vector<TextLine>{create,loose},"image-test");
        require(fused.size()==3,"unmatched OCR text retained");require(fused[0]["text"].is_null(),"parent container does not consume child label");
        require(fused[1]["text"]=="Create","smallest containing region selected");require(fused[1]["textRefs"][0]=="t1","OCR provenance linked");
        require(fused[2]["text"]=="外部文字"&&fused[2]["point"].is_null(),"text-only region not presented as clickable control");
        require(fused[2]["displayIndex"]==3,"overlay index agreement");
        require(fused[1]["nativeRef"].is_null()&&fused[1]["nativePatterns"].empty(),"no invented native control");
        std::cout<<"PASS checks="<<checks<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}

#include <desktop_pilot/ocr.hpp>
#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>
#include <stdexcept>

namespace dp {
void OcrOptions::validate() const {
    auto score_ok=[](float v){return std::isfinite(v)&&v>=0&&v<=1;};
    if(threads<1 || threads>64 || max_side<32 || max_side>2048 || max_lines<1 || max_lines>10000 ||
        !score_ok(pixel_threshold) || !score_ok(box_threshold) || !score_ok(text_threshold))
        throw std::invalid_argument("Invalid OCR options");
}
DecodedText decode_ctc(std::span<const float> data,size_t steps,std::span<const std::string> dict) {
    if(dict.size()<2 || steps>std::numeric_limits<size_t>::max()/dict.size() || data.size()!=steps*dict.size())
        throw std::invalid_argument("CTC tensor/dictionary shape mismatch");
    DecodedText out; size_t previous=0, count=0; double sum=0;
    for(size_t t=0;t<steps;++t) {
        auto row=data.subspan(t*dict.size(),dict.size());
        if(std::any_of(row.begin(),row.end(),[](float p){return !std::isfinite(p)||p<0||p>1.001f;}))
            throw std::runtime_error("CTC model must return finite probabilities, not logits");
        size_t current=size_t(std::max_element(row.begin(),row.end())-row.begin());
        if(current!=0 && current!=previous){out.text+=dict[current];sum+=row[current];++count;}
        previous=current;
    }
    out.confidence=count?float(sum/count):0.f;
    return out;
}
static Json bounds(Box b){return {{"space","image_px"},{"x",b.x1},{"y",b.y1},{"width",b.x2-b.x1},{"height",b.y2-b.y1}};}
Json text_lines_json(std::span<const TextLine> lines,const std::string& image_ref) {
    Json result=Json::array();
    for(size_t i=0;i<lines.size();++i) {
        const auto& line=lines[i];Json polygon=Json::array();
        for(auto p:line.polygon)polygon.push_back({p.x,p.y});
        result.push_back({{"textRef","t"+std::to_string(i+1)},{"imageRef",image_ref},{"text",line.text},
            {"bounds",bounds(line.box)},{"polygon",polygon},{"coordinateSpace","image_px"},
            {"recognitionScore",line.score},{"detectionScore",line.detection_score},{"source","ocr.ppocr_v4"}});
    }
    return result;
}
static float area(Box b){return std::max(0.f,b.x2-b.x1)*std::max(0.f,b.y2-b.y1);}
Json fuse_text(std::span<const Detection> detections,std::span<const TextLine> lines,const std::string& image_ref) {
    Json elements=detection_json(detections,image_ref);
    std::vector<std::vector<size_t>> members(detections.size());
    std::vector<size_t> unassigned;
    for(size_t t=0;t<lines.size();++t) {
        const auto& line=lines[t];size_t selected=detections.size();float best_area=std::numeric_limits<float>::max();
        for(size_t d=0;d<detections.size();++d) {
            auto box=detections[d].box;
            Box intersection{std::max(box.x1,line.box.x1),std::max(box.y1,line.box.y1),std::min(box.x2,line.box.x2),std::min(box.y2,line.box.y2)};
            float coverage=area(line.box)>0?area(intersection)/area(line.box):0;
            float cx=(line.box.x1+line.box.x2)/2,cy=(line.box.y1+line.box.y2)/2;
            if(coverage>=0.7f && cx>=box.x1 && cx<=box.x2 && cy>=box.y1 && cy<=box.y2 && area(box)<best_area) {
                selected=d;best_area=area(box);
            }
        }
        if(selected<detections.size())members[selected].push_back(t);else unassigned.push_back(t);
    }
    for(size_t d=0;d<detections.size();++d) {
        elements[d]["kind"]="detected_region";
        elements[d]["textRefs"]=Json::array();
        auto& group=members[d];
        // Sort by actual y then x: unlike tolerance-based comparators, this is transitive.
        std::stable_sort(group.begin(),group.end(),[&](size_t a,size_t b){
            return lines[a].box.y1!=lines[b].box.y1?lines[a].box.y1<lines[b].box.y1:lines[a].box.x1<lines[b].box.x1;
        });
        std::string joined;
        for(size_t t:group){if(!joined.empty())joined+='\n';joined+=lines[t].text;elements[d]["textRefs"].push_back("t"+std::to_string(t+1));}
        if(!group.empty()){elements[d]["text"]=joined;elements[d]["evidence"]["text"]="ocr.ppocr_v4";}
    }
    for(size_t t:unassigned) {
        auto& line=lines[t];auto ref="t"+std::to_string(t+1);
        elements.push_back({{"nodeRef",image_ref+":"+ref},{"nativeRef",nullptr},{"kind","text"},
            {"visualRef",{{"imageRef",image_ref},{"regionId",ref}}},{"bounds",bounds(line.box)},
            {"point",nullptr},{"text",line.text},{"textRefs",Json::array({ref})},
            {"evidence",{{"region","ocr.ppocr_v4"},{"text","ocr.ppocr_v4"}}},
            {"nativePatterns",Json::array()},{"state",{{"enabled","unknown"},{"occluded","unknown"}}}});
    }
    for(size_t i=0;i<elements.size();++i)elements[i]["displayIndex"]=i+1;
    return elements;
}
}

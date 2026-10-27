#include <desktop_pilot/worker.hpp>
#include <desktop_pilot/platform.hpp>
#include <sys/socket.h>
#include <sys/wait.h>
#include <spawn.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <cerrno>
#include <chrono>
#include <map>
extern char** environ;
namespace dp {
struct Worker::Impl {
    pid_t process=-1;int channel=-1;
    std::atomic<bool> cancelled=false;
    unsigned generation=0;
    std::map<std::string,std::pair<Json,Json>> receipts;
    void stop() {
        if(channel>=0)close(channel);channel=-1;
        if(process>0){kill(process,SIGKILL);while(waitpid(process,nullptr,0)<0&&errno==EINTR){} }process=-1;
    }
    ~Impl(){stop();}
    void start() {
        int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))throw std::runtime_error("Worker socket creation failed");
        for(int fd:pair)fcntl(fd,F_SETFD,FD_CLOEXEC);
        int yes=1;setsockopt(pair[0],SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
        posix_spawn_file_actions_t actions;posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_adddup2(&actions,pair[1],STDIN_FILENO);
        posix_spawn_file_actions_adddup2(&actions,pair[1],STDOUT_FILENO);
        posix_spawn_file_actions_addclose(&actions,pair[0]);posix_spawn_file_actions_addclose(&actions,pair[1]);
        std::string executable=executable_path().string();char mode[]="jsonl";
        char* argv[]={executable.data(),mode,nullptr};
        int error=posix_spawn(&process,executable.c_str(),&actions,nullptr,argv,environ);
        posix_spawn_file_actions_destroy(&actions);close(pair[1]);
        if(error){close(pair[0]);process=-1;throw std::runtime_error("Native worker start failed: "+std::to_string(error));}
        channel=pair[0];fcntl(channel,F_SETFL,O_NONBLOCK);++generation;
    }
};
Worker::Worker():impl_(std::make_unique<Impl>()){}
Worker::~Worker()=default;
void Worker::cancel(){impl_->cancelled=true;}
void Worker::reset_cancel(){impl_->cancelled=false;}
Json Worker::execute(const std::string& operation,const Json& args) {
    auto& p=*impl_;auto id=args.value("requestId",std::string{});
    Json payload={{"operation",operation},{"args",args}};
    if(!id.empty())if(auto it=p.receipts.find(id);it!=p.receipts.end()) {
        if(it->second.first!=payload)throw std::invalid_argument("requestId_conflict");
        auto result=it->second.second;result["replayed"]=true;return result;
    }
    if(operation=="action.status"&&!args.contains("requestId"))if(auto it=p.receipts.find(args.at("id").get<std::string>());it!=p.receipts.end())return it->second.second;
    int timeout=args.value("providerTimeoutMs",60000);
    if(timeout<1||timeout>600000)throw std::invalid_argument("providerTimeoutMs outside 1..600000");
    if(p.cancelled)return {{"status","error"},{"message","cancelled before dispatch"},{"dispatch","not_started"}};
    if(p.process<0)p.start();
    Json pending={{"status","unknown"},{"dispatch","unknown"},{"verification","unknown"},{"requestId",id}};
    if(!id.empty())p.receipts[id]={payload,pending};
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeout);
    try {
        auto check=[&] {
            if(p.cancelled)throw std::runtime_error("cancelled: provider stopped; prior side effects are not rolled back");
            if(std::chrono::steady_clock::now()>=deadline)throw std::runtime_error("provider_timeout: worker terminated; side effects may have occurred");
        };
        auto wait=[&](short events) {check();pollfd fd{p.channel,events,0};int n=poll(&fd,1,10);
            if(n<0&&errno!=EINTR)throw std::runtime_error("Worker poll failed");
            if(n>0&&(fd.revents&(POLLERR|POLLNVAL)))throw std::runtime_error("Worker channel failed");};
        const auto message=payload.dump()+"\n";size_t offset=0;
        while(offset<message.size()) {
            check();auto n=send(p.channel,message.data()+offset,message.size()-offset,0);
            if(n>0)offset+=n;else if(n<0&&(errno==EINTR||errno==EAGAIN))wait(POLLOUT);
            else throw std::runtime_error("Worker request write failed; dispatch outcome unknown");
        }
        std::string response;
        while(response.find('\n')==std::string::npos) {
            check();char buffer[65536];auto n=read(p.channel,buffer,sizeof(buffer));
            if(n>0)response.append(buffer,n);else if(n<0&&(errno==EINTR||errno==EAGAIN))wait(POLLIN);
            else throw std::runtime_error("Worker exited before response");
            if(response.size()>64*1024*1024)throw std::runtime_error("Worker response exceeds 64 MiB");
        }
        auto envelope=Json::parse(response);Json result;
        if(envelope.contains("error")){result=pending;result["status"]="error";result["message"]=envelope["error"]["message"];}
        else result=envelope.at("result");
        if(result.is_object()) {result["workerGeneration"]=p.generation;
            if(operation=="runtime.capabilities"){result["providerIsolation"]="worker_process";result["operations"].push_back("runtime.cancel");}}
        if(!id.empty())p.receipts[id].second=result;return result;
    } catch(const std::exception& e) {
        p.stop();auto result=pending;result["status"]="error";result["message"]=e.what();result["referencesInvalidated"]=true;
        result["retryability"]="re-observe; do not repeat a write with a new id until its outcome is checked";
        if(!id.empty())p.receipts[id].second=result;return result;
    }
}
}

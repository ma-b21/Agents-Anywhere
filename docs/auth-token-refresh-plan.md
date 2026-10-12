# 登录凭据自动刷新：实施与测试计划

日期：2026-10-12。状态：已获授权，按server → Android → Windows → Web实施，每端一个commit；每端修改、测试、独立审阅通过后提交。真实部署、设备验收和不足的测试环境单列，不冒充通过。

## 执行进度

策略基线：三十天空闲滑动续期、默认九十天绝对期限（原生可通过配置关闭）；密码变更撤销所有旧会话；有效旧会话自动升级、过期旧安装重新登录一次；Web以HTTPS/可信同源部署为推荐路径。短access TTL仅对明确声明新版协议的端启用，兼容旧端七天。

| 阶段 | 实施 | 测试 | 独立审阅 | commit |
| --- | --- | --- | --- | --- |
| server | 代码完成 | 可运行全套898通过；增补后专项218通过 | 最终复审通过；审阅者独立4项通过 | 5b20a74c |
| Android | 完成 | Kotlin2.2 controller编译、36项JVM/HTTP/边界通过；APK/真机未验 | 最终复审通过；审阅者独立36项通过 | d5236468 |
| Windows | 完成 | main可运行130项、Renderer321项通过；2项原有基线失败单列；类型检查/生产构建/系统加密通过 | 最终复审通过；审阅者独立31项通过 | 本阶段commit，下阶段回填hash |
| Web | 未开始 | 未执行 | 未执行 | 待提交 |

### server可执行清单

- [x] 数据迁移：会话、refresh历史/恢复、legacy拒绝标记、认证版本；SQLite writer/PG行锁轮换（PG实库验证未完成）。
- [x] token/session统一服务：sid、到期元数据、客户端绑定、轮换/同attempt恢复、空闲/绝对期限。
- [x] 全登录入口签发、OAuth refresh grant、Web bootstrap/CSRF/refresh/logout、legacy upgrade；refresh/upgrade共享限流。
- [x] HTTP与文件/终端/WS认证使用会话校验；密码/账号状态撤销，pending OAuth/QR认证版本复核。
- [x] 新增时钟/并发/恢复/撤销/CSRF/兼容测试，运行既有认证与相关回归（真实PG未验）。
- [x] 独立审阅，修复问题后复测通过；仅暂存server相关改动和本计划，提交server commit。

### Android可执行清单

- [x] 凭据模型、加密存储、atomic snapshot/pending attempt；扫码与OAuth均保存。
- [x] 单飞协调器、过期前刷新/401一次重试、取消与账号切换保护。
- [x] App生命周期、上传/下载、realtime最新token接入，临时故障不退出。
- [x] 单元/集成、可用构建和真机验收记录；独立审阅复测后提交Android commit。

Android阶段记录：项目同版Kotlin2.2编译API/模型/会话与realtime controller依赖图通过（未改动DevicesController底部纯映射抽取为本地编译fixture，排除Android UI和不相关AppUpdates，不等价完整APK）。状态机22项、真实localhost HTTP9项、controller存储异常边界5项通过，覆盖20请求单飞、持久化attempt、丢响应/重启恢复、写盘失败、旧401、认证仅一次重试、业务网络错误不重放、切账号/host保护、撤销、取消、legacy升级与降级、0TTL恢复、退出。离线Gradle已启动并解析项目，因本机无Android SDK停止；不把纯逻辑测试记为APK/Keystore/Compose验收。终端重连、前台定时续领及图片预览已接入认证通道。首轮独立审阅发现host错配、SharedPreferences先改内存后写盘、64代旧token淘汰、错误通知阻塞future等边界，已加严格上下文、原子读取、durable write barrier、fingerprint识别和必完成future，并补回归；图片/备份隔离同步收尾，最终复审通过，审阅者独立重跑36项全通过；APK/Compose/Keystore/真机仍是发布前门禁。

### Windows可执行清单

- [x] 主进程safeStorage会话/单飞、OAuth完整返回、窄IPC、多窗口共用。
- [x] Renderer请求/登录状态、代理/上传下载/realtime最新token接入（待独立审阅与复测）。
- [x] 主进程/Renderer测试、typecheck/build、系统加密与安装包未验记录；独立审阅复测后提交Windows commit。

Windows阶段记录：新增15项主进程协调器/存储/代理测试、3项终端重连测试、5项真实AuthProvider组件测试通过，覆盖20请求单飞、持久attempt及丢响应重启恢复、两处写盘失败、晚到401、网络不重放、退出/切号/错host保护、70代旧闭包、legacy升级、multipart重试、取消等待者、离线启动、同generation不拆实时连接及迟到退出成功不清新账号。main可运行130项通过；既有backend-client.test在未改源码/测试/protocol下单跑仍有ERR_IPC_CHANNEL_CLOSED，独立审阅者也复现，未算通过。Renderer322项中321通过，既有task-composer-preferences在未改new-session-content/测试中以LF结束标记匹配CRLF失败，未改测试冒充通过。Main/Renderer类型检查和静态生产构建通过；隔离userData下实际Windows safeStorage加密/解密通过，无真实凭据读取。首次审阅发现退出回调迟到清新账号UI，已加同步latestSession fencing和组件回归，最终复审通过；审阅者独立重跑31项专项全通过。未构建/安装新的NSIS exe、未接真实服务做跨TTL续登或多窗口实机验收，仍作为发布门禁。

### Web可执行清单

- [ ] Cookie/CSRF bootstrap、登录完整会话、失效分类与legacy升级。
- [ ] 页内/跨标签协调、凭据版本保护、请求一次认证重试、实时连接。
- [ ] Cookie/CSRF/乱序/跨标签测试，typecheck/build和可用E2E；审阅复测后提交Web commit。

执行记录：测试环境使用仓库server/.venv与独立缓存。首次uv命令继承活跃Connector环境并误移除其依赖，已按应用自带uv.lock恢复依赖与editable链接；Connector/SDK导入及沙箱命令恢复正常，未读改登录凭据和应用配置。后续不再使用隐式UV_PROJECT_ENVIRONMENT。

服务端验证记录（进行中）：首轮全套874通过、16跳过，发现2个迁移识别/历史fixture问题，已修复；新增限流曾违反服务层依赖规则，已去掉FastAPI依赖。Windows缺psutil/tzdata已补入独立测试环境。符号链接测试因WinError1314权限失败、协议工件字节比对因现有CRLF checkout失败，单列为环境/基线限制，未改写这些测试来冒充通过。独立审阅发现Connector入口漏校验、legacy WS关联、PG logout竞争和pending登录授权撤销4项，已增补实现及回归测试，等待复测/复审。PG实库/跨worker集成、生产部署及真机验收仍未执行。

服务端收尾结果：修复后可运行全量898 passed、16 skipped、2 deselected（另15项静态符号链接测试文件因权限未跑）；随后增补授权签发/profile竞态，最终认证+新会话+迁移+WS+架构+两种终端专项218 passed。Ruff F/I scoped check通过（既有star import的F403/F405不作为此次全仓lint通过）；独立审阅首轮问题及后续epoch竞态均闭环，审阅者独立focused 4 passed。SQLite迁移升级/降级、20同attempt并发、Redis跨实例限流通过；真实PG多worker、生产部署仍是发布前门禁。

## 1. 结论与目标

当前七天后退出登录的根因是固定有效期 access token，没有完整的刷新链路。Android 虽保存了扫码登录返回的 refresh token，但服务端没有可用的用户登录刷新入口，客户端也没有自动换发逻辑。

目标：Android、Windows、Web 在有效登录会话内自动续领 access token；连续使用不再因 access token 的七天有效期被踢出。账号被禁用、主动退出、凭据被撤销、长期不使用或达到配置的会话上限时，仍需要重新登录。

推荐顺序：服务端基础与协议 → Android → Windows → Web → 联调与灰度 → 调整新会话 access token 有效期。每阶段完成自动测试和独立审阅后再提交；计划记录实际完成情况，不把设计当成已实现。

不涉及：Connector 的机器凭据、第三方模型 API Key、Codex/Claude 自身登录、外部 OAuth 提供商的 token 刷新、其他原生功能适配。

## 2. 已核对的现状

以下路径相对仓库根目录。实施前复核分支差异，不读取或打印本机真实登录凭据。

| 层 | 现状 | 主要位置 |
| --- | --- | --- |
| 服务端 access token | 固定七天；JWT 目前只有用户与过期信息，没有登录会话关联 | server/agent_server/core/auth.py |
| 扫码登录 | 返回三十天的签名 refresh token；没有持久化、消费、轮换机制 | server/agent_server/api/auth.py |
| 原生 OAuth | /oauth/token 只实现 authorization_code；模型有可选 refresh_token，实际未签发 | server/agent_server/api/oauth.py、core/models.py |
| Android | 扫码凭据有保存但无读取/刷新；授权码登录未保存refresh；认证401触发清登录 | AuthSessionStore.kt、AuthController.kt、api/Auth.kt、api/ApiClient.kt、AgentsAnywhereApp.kt |
| Windows | Electron授权码交换只返回access；Renderer只存access，无刷新协调器 | electron/desktop-oauth.ts、Renderer的auth/session、auth-context、API client |
| Web | localStorage只存access；无刷新；启动检查失败未区分网络故障和登录失效 | web-next/src/features/auth/、src/components/auth/auth-context.tsx、src/lib/api/client.ts |
| 长连接 | bearer获取ws-ticket；部分恢复流程捕获旧token | Android realtime控制器及三端ws-ticket/重连调用链 |
| 存储与部署 | 有Alembic迁移，支持SQLite/PostgreSQL；CORS未开启allow_credentials | server/agent_server/infra/db/、server/agent_server/app.py |

refreshMe() 是重新获取用户资料，不是换发 token，不能视作已有刷新能力。

## 3. 建议的会话策略

### 3.1 有效期

建议默认值，均为待确认的可配置策略：

| 项目 | 建议 | 目的 |
| --- | --- | --- |
| 新版可刷新会话access | 全端验证完成后改为十五分钟 | 缩短access失窃暴露窗口；不能提前切换导致旧端掉线 |
| 旧版access-only会话 | 兼容期仍七天 | 服务端先上线不破坏旧客户端 |
| 会话空闲期限 | 三十天；有效续领成功时滑动续期 | 持续使用不因最初refresh的固定到期退出 |
| 会话绝对期限 | 建议默认九十天；原生可按自托管策略关闭 | 达到上限重新认证；与空闲期限不同 |
| 提前刷新窗口 | 剩余约六十秒；短TTL测试按比例缩小 | 减少业务撞上过期；仍需401兜底 |
| 原生轮换响应恢复窗口 | 建议两分钟，可配置并设上限 | 服务端已换发、响应却丢失时恢复 |

到期为 min(当前时间 + 空闲期限, 绝对期限)；没有绝对期限则只有前者。过期后不能靠刷新复活。

执行规则：先检查持久化的旧deadline，now >= deadline即拒绝；仅成功的新续领才按服务端UTC时间更新idle deadline。同attempt结果恢复不再次延长空闲期限或恢复窗口，普通access校验也不重算deadline。

九十天上限是安全/便利性建议，不是必须如此。希望原生持续使用长期不重登，可关闭原生绝对期限，保留空闲期限与撤销。Web 首期建议保留明确绝对期限；若也要求不限总时长，应单独确认并设计浏览器凭据续期，不能承诺首次登录后永久有效。

活跃首期定义：前台有业务请求，或正在查看会话/终端需保持实时连接，续领才延长空闲期限。不为长期闲置后台页建立永续定时器；服务端任务自行运行不算用户活跃。恢复前台/网络后按需刷新。

### 3.2 三端凭据承载

原生和浏览器共用会话生命周期与access签发逻辑，但不强求refresh secret同样存放：

- Android/Windows：不透明随机refresh token，每次成功刷新轮换，数据库只保存摘要。Android用Keystore保护持久化，Windows由Electron主进程用safeStorage保护。验证支持情况，不默默降级明文。
- Web：服务端管理的第一方会话Cookie，HttpOnly、HTTPS下Secure、合适SameSite；JS不读取持久化续登secret。Cookie认证的续领入口返回新access。
- Web首期Cookie固定绝对有效期；续领只延长服务端空闲期限，不每次轮换Cookie。因此标签页不竞争一次性refresh，也不会因刷新旧响应Set-Cookie覆盖新登录。登录/安全重认证时更换；正常有锁退出撤销并清Cookie，无锁受限退出只撤销expected sid、不清Cookie，见第6.3。
- 这是有意区分：原生一次性refresh需要轮换/丢包恢复；Web是可撤销浏览器会话凭据，不声称具有原生轮换的重放检测。Cookie被盗风险由HTTPS、HttpOnly、CSRF、期限与撤销控制。
- access仍用于现有bearer API/ws-ticket；新增refresh secret不进入Web/Renderer localStorage、日志、URL、消息或Connector配置。

Web推荐通过自托管反向代理与API同源；跨源须显式可信Origin + credentials，并加Origin/CSRF校验，不能任意Origin + 凭据。跨站第三方Cookie可能不可用，需实测；不支持则要求同源部署，不偷偷回退localStorage。远程明文HTTP不作为安全续登部署支持；本机开发有明确例外。

## 4. 服务端改造

### 4.1 持久化登录会话

建议新建auth_sessions、原生refresh历史/轮换记录及短时恢复记录；具体表名随仓库规范确定。

- session_id、user_id、client_id、transport（native/web）、设备展示信息。
- created_at、last_renewed_at、idle_expires_at、可空absolute_expires_at、revoked_at、撤销原因。
- 原生：当前refresh摘要、generation、已消费摘要/轮换关联，便于识别重放；历史保留到会话失效再清理。
- Web：Cookie secret摘要、固定Cookie/绝对到期信息；不存明文Cookie。
- 原生响应恢复记录：已消费摘要、attempt ID摘要、generation、恢复期限、加密的同一份换发结果。使用成熟AEAD库与独立可管理密钥，跨worker/重启一致；记录密钥版本以支持轮换，清理过期记录，不在日志暴露内容。不自制加密算法。

新access关联sid，校验时检查会话有效/未撤销；刷新不撤销同一会话尚未过期的access，避免并发请求因正常换发失效。权限仍按实时用户状态判断，不能把旧role永久固定在token里。

新服务端所有新登录的access都关联sid，旧客户端仍可拿七天access，但不因缺少客户端刷新实现被切短TTL。现存无sid的legacy JWT仅在兼容期认可；密码/安全撤销需要拒绝该用户所有无sid旧凭据的明确标记，否则不能声称“所有旧设备立即失效”。升级时保留/记录原凭据摘要，便于注销升级后的legacy关联凭据。

会话检查覆盖HTTP依赖和ws-ticket校验，不仅改current_user。注销后的新请求立即拒绝；现存WebSocket首期以数据库状态复核实现跨worker撤销，默认每秒一次（可配置），正常运行约一个检查周期内关闭，不声称网络/DB故障下瞬时广播。普通access到期不关闭有效会话的现存连接；后续可用Redis事件替代高频轮询优化负载。

迁移兼容SQLite/PostgreSQL；轮换使用数据库事务/比较并交换或行锁，多worker一致，不能只用Python锁/内存状态。

### 4.2 API与签发路径

以下为建议接口名，实际挂在现有API namespace下：

| 接口/路径 | 变化 |
| --- | --- |
| 全部用户登录路径 | 密码登录/注册、外部OAuth完成、原生授权码、扫码exchange，建立对应可续领会话；邮箱等前置条件不变 |
| POST /oauth/token | 增加grant_type=refresh_token；按grant校验字段；refresh不要求code/redirect_uri/code_verifier；授权码保留PKCE和一次性消费 |
| 原生refresh grant | 必传client_id、refresh_token、refresh_attempt_id；绑定first-party client，scope不得扩大 |
| POST /auth/session/refresh | Web Cookie + CSRF/Origin；返回access与会话元数据，不返回refresh secret、不设置新登录Cookie |
| POST /auth/session/logout | 撤销当前会话；Web有锁清Cookie、无锁只撤销expected sid（第6.3）；原生用refresh或有效access发起，不依赖已过期access |
| POST /auth/session/upgrade | 将仍有效legacy access-only会话升级；限制渠道/截止时间/重复兑换，不接受过期JWT；见第8节 |

响应包含明确的access到期时间/秒数、服务器时间、sid、空闲和绝对到期；原生另有新refresh及有效期。OAuth用snake_case，普通JSON可保留camelCase，经映射统一客户端模型。不混淆扫码现有expiresAt含义。

客户端统一快照建议字段：serverOrigin、apiNamespace、userId、sessionId、accessToken、accessExpiresAt、refreshToken（仅原生）、refreshExpiresAt（仅原生）、idleExpiresAt、absoluteExpiresAt（可空）、credentialVersion、serverTime、refreshProtocolVersion。时间统一UTC绝对时间，expires_in统一秒。服务器credentialVersion单调递增，防止并发续领的旧结果回写；它与客户端登录/切账号时变化的localLoginGeneration是两个独立概念，不能混用。

Web续领提交expectedSessionId用于一致性检查，不作为认证凭据；Cookie对应账号/sid不同则返回session_changed，不能作为原会话继续重试业务。安全凭据依然只有Cookie/原生refresh；用户ID和客户端传来的时间/版本均不能替代服务端校验。

更新OAuth metadata；refresh签发遵守client allowlist。DSH插件/Connector不自动获得新的长效用户凭据。

凭据响应Cache-Control: no-store；刷新限流、日志脱敏。Cookie作用域按部署origin/API namespace确定，同主机多套部署不能相互覆盖；同一Web安装的标签页共享账号会话，不承诺每个标签独立登录不同账号。

Web CSRF选定同步令牌方案：GET /auth/session/bootstrap在严格可信Origin/CORS下返回当前sid、用户摘要、CSRF token及服务器时间，不返回refresh secret、不修改登录Cookie，响应no-store。已有会话的CSRF token绑定sid，浏览器重开先bootstrap；过期/撤销会话不发有效令牌。匿名登录前用独立短时匿名CSRF上下文获取令牌，登录完成后切换到sid绑定令牌。状态变更请求发送X-CSRF-Token，服务端同时核对Origin、上下文/sid和令牌；缺失/不匹配返回csrf_failed，不自动登出，也不能将其当access过期无限重试。密码登录/注册、Cookie OAuth完成、续领、退出、Cookie upgrade均覆盖；原生无Cookie的PKCE/refresh链不强行套用浏览器CSRF。bootstrap的安全GET不要求先持有CSRF，但不可开放任意凭据Origin。

### 4.3 原生轮换与响应丢失

正常刷新：验证用户/会话/client → 事务验证当前摘要/generation → 消费旧凭据 → 签发新refresh/access → 保存摘要和短时加密恢复结果 → 提交 → 返回。

刷新前先持久化随机refresh_attempt_id；结果确定前重试同一次刷新使用同一ID：

1. 旧refresh首次消费成功，返回R1。
2. 响应丢失：窗口内用旧token + 同attempt重试，返回同一套R1/access凭据与原到期点，不再次轮换。响应serverTime使用当前时间，expires_in为实际剩余秒数，不把缓存结果当成重新获得一整段TTL。
3. 收到响应：在一次持久化事务/原子文件替换中保存R1/新access完整快照并清对应pending attempt，成功后唤醒等待者。磁盘失败保留旧快照与同attempt，走有界恢复；不得先清attempt再写凭据。
4. 下次刷新使用新attempt。
5. 旧凭据被不同attempt使用或超恢复窗口：明确拒绝；确认重放时撤销token family/会话。窗口不反复延期，不允许任意旧token宽限领取当前token。

首次及恢复均复核会话未撤销、用户未禁用/删除，不绕过到期；缓存结果仅在其generation仍为当前时返回，已经进入下一代不能把旧结果重新写回客户端。密钥变更/重启不能使有效恢复记录随机不可读。窗口是有界取舍：响应丢失后长期离线、超过窗口且本地只有旧token，可能需要重登，不承诺无限恢复。

### 4.4 错误与撤销

- 资源认证失败提供机器可读码，区分token过期/无效、账号禁用、普通权限不足。
- OAuth refresh使用协议错误对象，例如invalid_grant；客户端映射到reauth_required。Web同样返回明确会话失效码。
- 网络失败、超时、429、5xx、刷新结果未定：保留凭据、可恢复；按Retry-After/退避重试，不清登录。
- 无效/过期/撤销续登凭据、账号安全拒绝：停止刷新、提示重登。普通业务403不刷新/退出。
- 密码变更/重置建议撤销所有旧会话；若保留当前设备，显式重签当前会话。禁用/删除/管理员撤销立即生效。
- 撤销关闭关联用户连接；主动退出立即清本地状态，远端撤销结果独立处理，不被断网阻塞。未在线撤销的远端凭据可能暂时仍有效，不能声称已远端注销。

## 5. 三端公共请求算法

credential store + refresh coordinator；单飞（并发请求共用刷新）按规范化服务端origin/API namespace + 用户 + sid + 本次登录generation隔离，不能全局一个Promise。

正常请求：到期足够用当前access；临近/已过期先共用续领，保存完整新快照，再发出。

认证过期401：若已有新token，直接重试一次；仍是旧token则共用刷新后重试一次；身份已换/已退出则丢弃旧响应，禁止更新新会话。

1. 首次/重试从当前会话取token，盘点显式options.token/React闭包/协程捕获。仅处理当前用户会话；临时token、别的账号/server、auth:false、手工Authorization不擅自替换。
2. 刷新走无拦截独立请求，不递归刷新；登录/扫码查询/授权码等未认证请求不参与重试。
3. 仅明确认证拒绝且业务未执行，原业务最多重试一次。验证认证发生在副作用前；不能保证的接口先补协议。
4. 不因超时/断网自动重发消息、steer、停止等POST；无法判断执行结果时用既有查询/人工重试，业务幂等另立改造。
5. JSON/表单/上传体可重放；流需request factory或发送前预刷新。下载、上传、raw fetch/HttpURLConnection/本地代理全部审计。
6. 新快照持久化成功后释放等待者；失败不清唯一恢复信息、不发布半更新。原生pending attempt/凭据需抵抗进程中断。
7. 取消某个业务等待者不中断共享刷新；刷新有独立超时/生命周期。退出/切账号改变generation，旧结果不能覆盖新登录。
8. 凭据更新不重置会话、turn、草稿、终端和导航。最终退出先隔离账号敏感状态；网络故障不能走此路径。
9. 用服务器到期元数据、时钟偏差和可注入时钟；改本机时间不能续活已过期会话。
10. 不向绝对外部URL/重定向/其他server发送凭据；刷新拒绝跨origin重定向，按目标origin校验。

## 6. 分端实现清单

### 6.1 Android

下列Kotlin路径以android/app/src/main/java/com/agentsanywhere/app为根。

- api/Auth.kt：refresh grant/授权码响应字段，统一token/session metadata。
- AuthSessionStore.kt：完整读取/原子替换、pending attempt/generation；保留旧响应不能清新登录的保护；Keystore及旧SharedPreferences迁移。
- AuthController.kt：扫码/授权码两条登录保存完整会话；启动、回前台、恢复网络先ensureFreshSession再me/业务。
- ApiClient.kt：两条HTTP实现与multipart共用算法；onUnauthorized延后到确定不能恢复，不在首个401退出。
- AgentsAnywhereApp.kt：区分认证终止与临时故障；刷新更新凭据，不清会话/导航。
- DashboardRealtimeController.kt、SessionRealtimeController.kt、RealtimeApi.kt：取ticket/恢复读最新token，移除旧捕获；活跃前台长连接有限频率续领，后台不追求精确到点。

Mutex/共享Deferred等具体抽象按现有协程规范；页面销毁不能取消全应用刷新。

### 6.2 Windows

- electron/desktop-oauth.ts：交换返回完整结果，不只字符串；state/PKCE/回调校验保留。
- 主进程安全credential store/协调器，绑定server；safeStorage校验后写盘。开发快捷登录明确可刷新会话还是仅开发例外。
- electron/preload.ts、shared bridge、IPC：仅必要会话状态/有效access/退出，不让Renderer任意URL带refresh请求。
- Renderer的features/auth/session、types、auth-context、API client：迁移access-only；新access原子更新，显式token调用统一取当前会话。
- electron/api-proxy.ts、下载/上传/realtime：不扩大凭据目标；ticket/重连用新token。
- 多窗口主进程共用刷新；切账号/server、重启/中断恢复入测试。

### 6.3 Web

- 登录设置HttpOnly Cookie；续领显式credentials + CSRF/Origin。续领不Set-Cookie，避免迟到刷新覆盖登录。
- features/auth/types、session、API、auth-context、API client：只保存access/session metadata；me失败按分类恢复，断网不登出。
- 页内单飞；跨标签优先Web Locks + BroadcastChannel，通知后读取新access/session metadata；退出/账号切换广播generation。
- 取跨标签锁后复核token version，避免等待者逐个刷新。无Web Locks时不以localStorage普通读写冒充可靠锁；允许非一次性Cookie续领有界重复，仍页内单飞/版本保护；严格跨标签一次仅在支持协调器时成立。
- 登录/退出/切账号也进入跨标签协调；同步CSRF生命周期。Cookie与已知账号不一致则停业务、重取身份，不能把另一账号token写入原状态。
- 首期身份变更必须持有Web Locks，锁覆盖请求发出、响应接收和身份快照提交，login/logout/upgrade/切号共用认证锁，logout也校验expectedSessionId；不能仅靠JS generation忽略Set-Cookie。无可靠锁的浏览器不开放新的Cookie登录/upgrade/切号，提示使用支持浏览器；现存Cookie可按上述降级续领，退出只撤销expected sid、不返回删除Cookie的Set-Cookie，避免迟到退出清掉另一会话。受限支持明确展示，后续再做可靠协调器替代，不静默冒充完整多标签支持。
- 保留现有access缓存是兼容取舍，未解决全部XSS；长期续登secret不进localStorage。refresh返回用户信息可核对，不靠解码JWT当身份验证。
- 验收同源/跨源、第三方Cookie禁用、多标签、挂起恢复。不扩成与实际部署无关的大型BFF重写。

## 7. 长连接与运行中的会话

常规换发不主动断当前WebSocket、不停止服务端turn。新连接/恢复用当前有效token申请ticket；ticket一次性/时效规则保持。

token更新只通知凭据依赖，不触发账号退出效果。认证断连先续领再领ticket，不循环使用旧捕获。验证实时流、侧栏、steer/停止正常，不需切换会话恢复。

安全撤销不同于常规换发：关闭受影响用户连接，但不借此停止Connector任务；运行时按既有策略继续。首期跨worker数据库复核与断连原因码纳入实现/联调，检查间隔/故障行为需在部署验收确认。

## 8. 旧会话、上线与回滚

1. 服务端迁移/协议先上线，旧响应兼容、旧access七天；新字段可选/按能力签发，旧端不意外切十五分钟。
2. 新端识别refreshProtocolVersion/能力及完整凭据；旧服务端不无限刷新重试，沿用兼容行为。
3. 仍有效legacy access调用一次有界upgrade；先持久化本安装upgrade_attempt_id，按legacy摘要/client/attempt幂等并限流，不能每次启动建会话。不同安装独立attempt，避免旧JWT偶然相同导致两设备共用一个原生refresh。失败保留旧凭据至原expiry。
4. upgrade仅管理员兼容窗口开放，示例三十天；不把过期JWT当身份。有效旧access升级增加续登能力，明确窗口与安全取舍。
5. 旧签名QR refresh不属于新轮换：建议凭有效access升级，否则重新登录一次。若必须迁移旧QR，另做签名/aud/exp及消费摘要持久化的单次迁移。
6. 全端验收后，只对具备新session/刷新能力的端启用短access TTL；观察真实七天边界后结束legacy。
7. 回滚优先客户端/短TTL开关，保留新接口/表读取兼容；不能退到完全不认识sid/refresh的服务端并称无影响。安全紧急问题可撤销并要求重登，需告知。

上线备份DB，在空库/真实旧结构副本验迁移。指标仅脱敏session/client、成功率、invalid_grant分类、临时失败、单飞等待、同attempt恢复；不记原始token/密码/Cookie。

## 9. 批次与提交门槛

| 批次 | 交付 | 门槛 |
| --- | --- | --- |
| P0协议冻结 | 模型/错误码、期限/撤销/Web Cookie、兼容 | 核对登录路径/部署，确认第12节 |
| P1服务端持久化 | 表、session service、签发、sid校验、撤销 | 双数据库迁移/单元、旧认证回归 |
| P2服务端续领 | refresh grant/幂等恢复、Web、logout/upgrade | 多worker、丢响应、身份/CSRF/失效；独立审阅 |
| P3 Android | 存储/协调器、HTTP/生命周期/realtime | 单元/集成、APK/真机两种登录；独立审阅再commit |
| P4 Windows | 主进程存储、OAuth/IPC、Renderer/代理 | Electron/Renderer、构建/安装包；独立审阅再commit |
| P5 Web | Cookie、续领、多标签/部署 | 单元/typecheck/build、浏览器E2E；独立审阅再commit |
| P6联调灰度 | 全端边界/观测、短TTL开关、迁移/回滚 | 第11节，真实部署小范围观察 |

每批只提交对应代码/测试/进度，保留其他未提交改动。P1/P2可拆commit，但完整协议通过才让客户端依赖。

## 10. 测试设计

### 10.1 方法

服务端/客户端核心注入时钟，自动推进fake clock经过七天/三十天/九十天，不等待真实时间、不改机器系统时间。E2E只在测试环境设access三十至六十秒、空闲三至五分钟、绝对十分钟；提前窗口按比例调整。

先写现状失败回归：access过期但有效续登凭据不能恢复、并发401多次退出/刷新、启动me断网误清会话。修复使同一测试变绿，不只测happy path。

### 10.2 服务端必测

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| S01 | 密码/注册、OAuth finalize、Android/Windows授权码、扫码 | 全部建立会话，原授权/邮箱/PKCE不变 |
| S02 | access过期，refresh/Cookie仍有效 | 续领成功，用户/client/scope不变，新bearer可访问 |
| S03 | 连续轮换与空闲滑动 | 新token，旧单次消费；可越最初refresh到期，不能越绝对上限 |
| S04 | 空闲/绝对过期边界 | 拒绝、不复活，服务器时间为准，now==expires_at一致 |
| S05 | 禁用/删除、改密码、logout/管理员撤销 | refresh/资源/ticket拒绝，现存连接撤销，不伤其他账号 |
| S06 | 同原生token+同attempt并发，多worker | 唯一generation更新；窗口内同一结果，无多个可用分支 |
| S07 | 同旧token+不同attempt、跨client/扩scope | 拒绝；按策略撤销；不串账号/提升权限 |
| S08 | 提交后丢响应、重试/重启 | 窗口内同结果；撤销/过期不可恢复；窗口外明确失效 |
| S09 | DB故障/事务中断、恢复密钥变更、限流 | 无半消费；5xx/429可区分，密钥兼容/失败策略明确 |
| S10 | Web合法/恶意Origin、无CSRF、跨源 | 合法可用；攻击站点不能续领/退出/切账号，无宽泛凭据CORS |
| S11 | Web并发续领/登录切换 | 续领无Set-Cookie，身份核对、旧结果不覆盖新账号，Cookie期限一致 |
| S11b | 旧退出晚于新登录、两次登录响应乱序、无锁浏览器 | 有锁正确串行，实际Cookie与UI身份一致；无锁拒绝新的身份变更，既有会话退出仅撤销预期sid、不覆盖Cookie |
| S11c | CSRF匿名登录、sid更换、浏览器重开bootstrap | 匿名/会话令牌不能混用；旧sid令牌无效；缺令牌/攻击Origin拒绝，不产生登出循环 |
| S12 | legacy升级/重复/过期upgrade | 有效窗口内可升级，不反复造会话；过期/越界拒绝，旧QR不偷变长效 |
| S13 | 旧端/metadata/错误对象/缓存头 | 老授权码有效；refresh字段校验正确；no-store，日志无secret |
| S14 | 双DB旧库迁移、多worker、cleanup | SQLite/PG一致；清理不破坏有效轮换/重放检测 |

扩展server/tests/test_auth.py，新增refresh/session repository测试，补test_server_push_websocket.py等认证回归。PG并发不能用SQLite单进程测试替代。

### 10.3 三端通用必测

- C01：二十请求同时过期，仅一次刷新，各业务最多一次认证重试；刷新后新请求直接用新token。
- C02：晚到旧401使用已有新token，不再刷新/清登录；第二次认证失败不循环。
- C03：断网、超时、429/5xx保留登录/草稿，恢复后续领；明确失效仅通知一次退出。
- C04：刷新中退出/切账号/server，旧结果不覆盖；旧请求不带新账号token重发到旧业务上下文。
- C05：返回后持久化前后杀进程，重启可恢复或明确失效，无access/refresh半更新。
- C06：取消一等待者，其他可完成；刷新不递归，auth:false不参与。
- C07：JSON/FormData/multipart、下载/代理/ticket用新token；流不盲目重放。
- C08：消息/steer/停止认证401后只执行一次；网络超时不自动重发，服务端计数无重复turn。
- C09：不丢会话/草稿/终端、不停turn；连接恢复/侧栏不需切会话。
- C10：本机错时、前后台挂起、过期启动、旧安装无metadata均可控恢复。
- C11：外部URL/重定向/恶意IPC无法取凭据；日志/错误/存储无明文refresh泄漏。

Android加测扫码/授权码、进程死亡、后台跨access TTL回前台、Keystore故障/迁移。Windows加测多窗口、safeStorage故障、切server、代理、重启/OAuth。Web加测三个标签、支持/不支持Web Locks、切账号广播、Cookie禁用、同源/跨源、CSRF、关浏览器重开。

### 10.4 构建和实际验收

以下是未来验收入口，本轮不执行；实施时核对仓库脚本：

- server：uv run pytest tests/test_auth.py，再跑新增refresh/WS/全套；PG单独配置测试库。
- desktop-workbench：corepack yarn test:main、corepack yarn typecheck、corepack yarn renderer:typecheck；Renderer用corepack yarn workspace agents-anywhere-desktop-renderer test，整体corepack yarn build；最后corepack yarn dist:win，装exe验OAuth/续登/会话与文件操作。
- web-next：corepack yarn test、corepack yarn typecheck、corepack yarn build，再新增浏览器E2E。
- android：./gradlew.bat :app:testDebugUnitTest :app:assembleDebug，按需设备测试。此前本机缺Android SDK/AGP缓存；若仍缺，明确“纯逻辑通过，APK/真机未验收”，不记全通过。

E2E：各端登录 → 持续超过短access TTL的任务 → 不切会话观察更新 → 到期后消息/steer/停止 → 断网跨TTL恢复 → 重启 → 丢一次原生刷新响应后恢复 → 多窗口/标签并发 → 服务端撤销 → 确认退出及其他设备策略。

用代理/可控fetch故障注入，不在真账号日志打印凭据。构建成功不代表续登通过；短TTL E2E不能替代后续真实七天观察。

## 11. 完成标准

- [ ] 所有登录入口可续领，无某一种七天仍掉的遗漏。
- [ ] fake clock越七天，活跃三端无感续登；空闲/绝对期限按配置。
- [ ] 原生轮换、多worker、同attempt有界恢复、重放撤销通过。
- [ ] 并发共用；Web支持协调器时跨标签一次，否则有界并发不误退出。
- [ ] HTTP/上传下载/ticket/重连真正用新token，无旧闭包残留。
- [ ] 临时故障不清登录，安全撤销真正终止受影响会话。
- [ ] 消息/steer/停止不重复，正常刷新不丢任务/草稿。
- [ ] 三端测试/构建/审阅及实际部署、真机/安装包记录；未验明确。
- [ ] legacy窗口、安全存储、Web部署限制、备份/回滚可操作。
- [ ] 无新增向自托管服务之外发送用户凭据的链路。

## 12. 开工前确认的产品选择

以下不阻止当前方案整理；实施前确认，避免把建议写成产品默认：

1. 期限：接受三十天空闲/九十天总时长，还是原生关闭绝对期限？Web是否接受首期九十天上限？
2. Web能否同源/HTTPS代理？若必须跨站且Cookie不可用，另设计部署/BFF，不走localStorage兜底。
3. 改密码：所有设备重新登录，还是重签保留当前设备？
4. 旧安装：接受有效会话自动升级、过期重登一次，还是另做旧扫码refresh单次迁移？建议前者。

建议先P0/P1/P2和服务端故障注入，再Android；不要三端先发刷新，最后补服务端和会话策略。

跨端补充复审：Android与Windows已补第二次业务401迟到时按被拒绝token与credentialVersion条件撤销，避免清掉已并发换发的新凭据。Android22项状态机、Windows16项主进程专项独立复测通过；旧第二401真正失效测试仍通过。各端原有发布前门禁不变。

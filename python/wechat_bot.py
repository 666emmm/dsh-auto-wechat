import os
import sys
import time
import json
import re
import hashlib
import ctypes
from ctypes import wintypes
import numpy as np
from PIL import Image, ImageGrab
import requests
import pyperclip
from rapidocr_onnxruntime import RapidOCR

# =============================================================================
# 0. WIN32 API DEFINITIONS & DESKTOP BINDING
# =============================================================================
user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
shcore = ctypes.windll.shcore
kernel32 = ctypes.windll.kernel32

try:
    shcore.SetProcessDpiAwareness(2) # Per-monitor DPI aware
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass

def ensure_default_desktop():
    try:
        h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
        if h_desk:
            user32.SetThreadDesktop(h_desk)
            user32.CloseDesktop(h_desk)
    except Exception:
        pass

ensure_default_desktop()

# =============================================================================
# 1. CONSTANTS & SYSTEM PATHS
# =============================================================================
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 数据目录：配置/日志/pid 一律落在这里，不再放插件包内。
# 优先级：--data-dir 参数 > 环境变量 > $DSH_HOME/integrations/dsh-auto-wechat > 包目录（兜底）
def _resolve_data_dir():
    for i, a in enumerate(sys.argv):
        if a == "--data-dir" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if a.startswith("--data-dir="):
            return a.split("=", 1)[1]
    env = os.environ.get("DSH_AUTO_WECHAT_DATA")
    if env:
        return env
    home = os.environ.get("DSH_HOME")
    if not home:
        home = os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "integrations", "dsh-auto-wechat")

DATA_DIR = _resolve_data_dir()
try:
    os.makedirs(DATA_DIR, exist_ok=True)
except Exception:
    DATA_DIR = BASE_DIR   # 建不出来就退回包目录，至少还能跑

CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
CONVO_MAP_FILE = os.path.join(DATA_DIR, "wechat_convo_map.json")
PID_FILE = os.path.join(DATA_DIR, "wechat_bot.pid")
LOG_FILE = os.path.join(DATA_DIR, "wechat.log")

try:
    if sys.stdout:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if sys.stderr:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# --stdio 模式下 stdout 是 JSON 协议通道，人读日志必须走 {"t":"log"} 或 stderr，
# 绝不能直接 print 明文 —— 那会把协议行污染成非 JSON，插件侧解析直接崩。
STDIO_MODE = False

def _emit_log_json(level, msg):
    try:
        sys.stdout.write(json.dumps(
            {"t": "log", "level": level, "msg": str(msg)}, ensure_ascii=False
        ) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

def log(msg, level="info"):
    timestamp = time.strftime("[%Y-%m-%d %H:%M:%S]")
    line = f"{timestamp} {msg}"
    if STDIO_MODE:
        _emit_log_json(level, line)
    else:
        try:
            print(line, flush=True)
        except Exception:
            try:
                print(line.encode("gbk", errors="ignore").decode("gbk"), flush=True)
            except Exception:
                pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

# =============================================================================
# SINGLETON GUARD —— 全局命名互斥体，进程死了系统自动释放，无残留锁文件问题
# =============================================================================
# 为什么必须有：GUI 曾经被重复启动两次（.venv 的 pythonw + 内置 python 的 pythonw），
# 各自拉起一个守护进程，两个进程同时 OCR 同一条消息 → 同一条消息调两次模型、
# 发两条回复。PID 文件只写不查挡不住这种，必须用内核互斥体。
_SINGLETON_MUTEX = None

def acquire_singleton(name="Global\\DshAutoWechatDaemon"):
    """
    尝试取得单实例锁。成功返回 True；已有实例在跑返回 False。
    handle 必须活到进程结束（存全局），否则锁会被提前释放。
    """
    global _SINGLETON_MUTEX
    try:
        ERROR_ALREADY_EXISTS = 183
        handle = kernel32.CreateMutexW(None, True, name)
        last_err = kernel32.GetLastError()
        if not handle:
            log("⚠️ [单实例] 无法创建互斥体，按单实例继续运行（无保护）")
            return True
        if last_err == ERROR_ALREADY_EXISTS:
            try:
                kernel32.CloseHandle(handle)
            except Exception:
                pass
            return False
        _SINGLETON_MUTEX = handle
        return True
    except Exception as e:
        log(f"⚠️ [单实例] 互斥体异常 {e}，继续运行（无保护）")
        return True

def init_ocr():
    models_dir = os.path.join(BASE_DIR, "models")
    if not os.path.exists(models_dir):
        models_dir = os.path.join(BASE_DIR, "_internal", "models")

    det_model = os.path.join(models_dir, "ch_PP-OCRv4_det_infer.onnx")
    cls_model = os.path.join(models_dir, "ch_ppocr_mobile_v2.0_cls_infer.onnx")
    rec_model = os.path.join(models_dir, "ch_PP-OCRv4_rec_infer.onnx")
    
    if os.path.exists(det_model) and os.path.exists(rec_model):
        try:
            return RapidOCR(det_model_path=det_model, cls_model_path=cls_model, rec_model_path=rec_model)
        except Exception:
            pass
    return RapidOCR()

# Initialize local neural network OCR engine
_rapid_ocr = init_ocr()

def ocr_engine(img, *args, **kwargs):
    """
    统一入口：**永远把 PIL Image 先转成 numpy 再交给 rapidocr**。

    ── 为什么必须这样（2026-11-04 定位）──
    rapidocr_onnxruntime/utils/load_image.py 里：

        if channel == 3:
            if issubclass(origin_img_type, (str, Path, bytes, Image.Image)):
                return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)   # ← 传 PIL 走这条
            return img                                        # ← 传 ndarray 直接返回

    传 PIL Image 时它会自己调 cv2.cvtColor，而这台机器上 opencv 5.0.0 +
    numpy 2.5.4 这个组合会**偶发**抛 `cv2.error: Unknown C++ exception
    from OpenCV code`（20 次压测不复现，但守护进程里必现）。

    传 numpy 数组则完全跳过那行 cvtColor —— 我们自己在外面转，可控。
    注意通道顺序：PIL 是 RGB，rapidocr 对 ndarray 输入**不做转换**，
    直接当 BGR 用。所以这里要自己 cv2.cvtColor(RGB2BGR)，
    否则红蓝通道颠倒会影响彩色气泡判定（绿底/非绿底）。
    """
    import numpy as _np
    try:
        import cv2 as _cv2
    except Exception:
        _cv2 = None

    arr = img
    if not isinstance(arr, _np.ndarray):
        # PIL / 其它 → ndarray（RGB）
        arr = _np.array(img)
    if arr.ndim == 3 and arr.shape[2] == 4:
        arr = arr[:, :, :3]           # 去 alpha
    if arr.ndim == 3 and arr.shape[2] == 3 and _cv2 is not None:
        # RGB → BGR，跟 rapidocr 自己会做的事保持一致
        try:
            arr = _cv2.cvtColor(_np.ascontiguousarray(arr), _cv2.COLOR_RGB2BGR)
        except Exception:
            arr = _np.ascontiguousarray(arr)   # 連 cvtColor 都崩就原样喂，至少还能识别黑白文字
    else:
        arr = _np.ascontiguousarray(arr)
    return _rapid_ocr(arr, *args, **kwargs)

# =============================================================================
# 2. CONFIGURATION & STATE MANAGEMENT
# =============================================================================
LAST_PROCESSED_SIGNATURE = {}
# 每个对话最后处理过的时间。签名必须配时间窗，否则"对方隔很久又说同一句话"
# 会被永久拦住（表现为偶尔不回消息）。
LAST_PROCESSED_AT = {}
# 每个对话最后处理过的文本 + 时间，用途同上（防气泡滚动重识别）
LAST_REPLIED_TEXT = {}
LAST_REPLIED_AT = {}
API_CONVERSATION_HISTORY = {}
LAST_CLICKED_CANDIDATE_TIME = {}
SEND_FAIL_RETRY = {}
# 插件通过 {"t":"config"} 下发的运行时覆盖（只存内存，不落盘；空 dict 时全走配置文件）
_RUNTIME_OVERRIDES = {}
LAST_CHAT_HASH = None
LAST_SIDEBAR_HASH = None
LAST_FULL_SCAN_TIME = 0

def load_config():
    """
    读配置。优先级：插件下发的内存覆盖 > DATA_DIR/config.json > 内置默认。
    ⚠️ 默认值里**不放任何示例好友名** —— 旧版默认 ["好友A","好友B"] 会让人误以为
       配置读到了，实际是占位符。白名单为空就是空，没配就是没配。
    """
    cfg = None
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception as e:
            log(f"⚠️ [配置读取失败] {CONFIG_FILE}: {e}", "warn")
    if cfg is None:
        if not os.path.exists(CONFIG_FILE):
            log(f"⚠️ [配置文件不存在] {CONFIG_FILE} —— 白名单为空，不会回复任何人。"
                f"去设置页填白名单，或用 --data-dir 指向正确目录", "warn")
        cfg = {}
    if _RUNTIME_OVERRIDES:
        cfg = {**cfg, **{k: v for k, v in _RUNTIME_OVERRIDES.items() if v is not None}}
    return {
        "whitelist_mode": True,
        "whitelist": [],
        "group_whitelist": [],
        "blacklist": ["文件传输助手", "微信团队", "订阅号", "公众号", "服务号"],
        "reply_delay_seconds": 0.0,
        "check_interval_seconds": 0.8,
        "ignored_keywords": ["按住鼠标", "语音输入文字", "按住说话", "按Enter发送", "发送(S)"],
        "friend_personas": {},
        "group_personas": {},
        **cfg,
    }

def load_convo_map():
    if os.path.exists(CONVO_MAP_FILE):
        try:
            with open(CONVO_MAP_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

_CFG_WARNED = set()

def cfg_float(dct, key, default):
    """健壮读取数字配置项：非法/缺失时回退默认值，每个键只告警一次防刷屏"""
    try:
        return float(dct.get(key, default))
    except Exception:
        if key not in _CFG_WARNED:
            _CFG_WARNED.add(key)
            log(f"⚠️ [配置项无效] {key} 不是合法数字，已回退默认值 {default}")
        return float(default)

# =============================================================================
# 3. DPI & PHYSICAL LAYOUT ENGINE (WINDOW-SIZE INVARIANT)
# =============================================================================
def get_dpi_scale():
    try:
        hdc = user32.GetDC(0)
        log_w = gdi32.GetDeviceCaps(hdc, 8)  # HORZRES
        phys_w = gdi32.GetDeviceCaps(hdc, 118) # DESKTOPHORZRES
        user32.ReleaseDC(0, hdc)
        scale = phys_w / float(log_w)
        return scale if scale > 0 else 1.0
    except Exception:
        return 1.0

def compute_wechat_layout(W, H):
    """
    基于微信 PC 客户端原生物理布局结构计算关键区域：
    无论窗口拉宽、拉高、缩小或最大化，物理像素绝对精准咬合。
    """
    sidebar_w = max(55, int(0.055 * W))
    chat_start_x = max(320, int(0.285 * W))
    header_h = max(85, int(0.110 * H))
    input_h = min(220, max(140, int(0.160 * H)))
    
    return {
        "sidebar_w": sidebar_w,
        "chat_start_x": chat_start_x,
        "header_h": header_h,
        "input_h": input_h,
        "total_w_px": W,
        "total_h_px": H
    }

def sidebar_row_click_x(layout):
    """
    左侧会话列表某一行的安全点击横坐标。
    单一来源：全文所有「点左侧列表行」的地方都必须走这里，
    禁止再出现 int(0.16 * W) 这类写死比例 —— 群聊/好友行高不同，
    固定比例会点偏，点偏后顶栏复核失败直接熔断，永远发不出去。
    """
    sidebar_w = layout["sidebar_w"]
    chat_start_x = layout["chat_start_x"]
    # 行内文字左对齐，取可见文本带（排除右边缘红点与滚动条）的中段
    return int(sidebar_w + 0.45 * (chat_start_x - sidebar_w))

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, ctypes.c_ssize_t)

def get_wechat_hwnd():
    ensure_default_desktop()
    candidates = []
    def enum_proc(hwnd, lp):
        class_buff = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buff, 256)
        c = class_buff.value
        if "Qt51514QWindowIcon" in c or "WeChatMainWndForPC" in c:
            wname = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, wname, 256)
            t = wname.value
            # 微信 4.0 伴随空壳代理窗口标题固定为纯英文 "Weixin"
            is_shell = (t == "Weixin")
            ver = 4 if "Qt" in c else 3
            candidates.append((hwnd, ver, t, is_shell))
            if is_shell:
                try:
                    user32.ShowWindow(hwnd, 0) # SW_HIDE 静默隐藏空壳代理窗口
                except Exception:
                    pass
        return True
        
    cb = WNDENUMPROC(enum_proc)
    user32.EnumWindows(cb, 0)
    
    # 严格优先选取真实主聊天窗口 (排除空壳窗口)
    real_candidates = [c for c in candidates if not c[3]]
    if real_candidates:
        return real_candidates[0][0], real_candidates[0][1]
    if candidates:
        return candidates[0][0], candidates[0][1]
    return None, None

def grab_wechat_window(hwnd):
    """
    后台静默抓图引擎（PrintWindow）。

    ── 2026-11-04 加的最小化防护 ──
    微信被最小化时 GetWindowRect 返回 (-21333,-21333) 158x26，
    PrintWindow 抓到的是纯灰 211 的一小条。后果：
      · compute_wechat_layout 算出 chat_start_x=320 > 窗口宽 237
        → 右侧聊天区所有坐标全废
      · 气泡解析把左侧列表预览当成聊天内容
        → 日志里出现 "昨天19:24"、"AAA跨境运营小王子" 这种串味文本
      · 模型收到一堆垃圾，要么乱回要么炸

    所以抓图前先确保窗口不是最小化的。用 SW_RESTORE(9) 恢复，
    但不抢前台（SWP_NOACTIVATE），用户的窗口焦点不动。
    """
    try:
        # ── 最小化检测与恢复 ──
        if user32.IsIconic(hwnd):
            log("🪟 [窗口已最小化] 正在恢复（不抢前台）…", "warn")
            try:
                user32.ShowWindow(hwnd, 9)      # SW_RESTORE
                time.sleep(0.35)                # 等 Qt 重新布局
            except Exception as e:
                log(f"⚠️ 恢复窗口失败：{e}", "warn")

        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        if w <= 0 or h <= 0:
            w, h = 1100, 750

        # 尺寸太小的窗口抓了也没用 —— 直接拒绝，让上层等下一轮，
        # 不要拿一张 158x26 的碎图去算 layout 和气泡（那会产出串味文本）。
        if w < 400 or h < 300:
            log(f"⚠️ [窗口过小] {w}x{h} —— 微信可能还在最小化，本轮跳过抓图", "warn")
            return None, rect, 1.0
            
        scale = get_dpi_scale()
        
        hwnd_dc = None
        mfc_dc = None
        save_bitmap = None
        img = None
        try:
            hwnd_dc = user32.GetWindowDC(hwnd)
            mfc_dc = gdi32.CreateCompatibleDC(hwnd_dc)
            save_bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, w, h)
            gdi32.SelectObject(mfc_dc, save_bitmap)
            
            result = user32.PrintWindow(hwnd, mfc_dc, 2)
            if not result:
                result = user32.PrintWindow(hwnd, mfc_dc, 0)
                
            if result:
                class BITMAPINFOHEADER(ctypes.Structure):
                    _fields_ = [
                        ('biSize', wintypes.DWORD),
                        ('biWidth', wintypes.LONG),
                        ('biHeight', wintypes.LONG),
                        ('biPlanes', wintypes.WORD),
                        ('biBitCount', wintypes.WORD),
                        ('biCompression', wintypes.DWORD),
                        ('biSizeImage', wintypes.DWORD),
                        ('biXPelsPerMeter', wintypes.LONG),
                        ('biYPelsPerMeter', wintypes.LONG),
                        ('biClrUsed', wintypes.DWORD),
                        ('biClrImportant', wintypes.DWORD)
                    ]
                bmi = BITMAPINFOHEADER()
                bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
                bmi.biWidth = w
                bmi.biHeight = -h # top-down
                bmi.biPlanes = 1
                bmi.biBitCount = 32
                bmi.biCompression = 0
                
                buf = ctypes.create_string_buffer(w * h * 4)
                gdi32.GetDIBits(mfc_dc, save_bitmap, 0, h, buf, ctypes.byref(bmi), 0)
                img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1).convert('RGB')
        finally:
            if save_bitmap:
                gdi32.DeleteObject(save_bitmap)
            if mfc_dc:
                gdi32.DeleteDC(mfc_dc)
            if hwnd_dc:
                user32.ReleaseDC(hwnd, hwnd_dc)
        
        if img and np.array(img).max() > 10:
            return img, rect, scale
        else:
            # 备用：物理截屏 (仅当在正常屏幕内时)
            if rect.left > -1000 and rect.top > -1000:
                bbox = (int(rect.left * scale), int(rect.top * scale), int(rect.right * scale), int(rect.bottom * scale))
                fallback_img = ImageGrab.grab(bbox=bbox).convert('RGB')
                return fallback_img, rect, scale
            return img, rect, scale
    except Exception:
        return None, None, 1.0

def activate_wechat(hwnd):
    """
    Win32 穿透提权引擎：
    突破 Windows 10/11 防抢焦点 (ASFW) 与输入队列隔离，赋予微信合法键盘输入权限。
    """
    try:
        ensure_default_desktop()
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9) # SW_RESTORE
            time.sleep(0.04)
            
        cur_fore = user32.GetForegroundWindow()
        cur_thread = user32.GetWindowThreadProcessId(cur_fore, None) if cur_fore else 0
        wx_thread = user32.GetWindowThreadProcessId(hwnd, None)
        my_thread = kernel32.GetCurrentThreadId()
        
        attached_cur = False
        attached_my = False
        try:
            if cur_thread and cur_thread != wx_thread:
                attached_cur = bool(user32.AttachThreadInput(cur_thread, wx_thread, True))
            if my_thread and my_thread != wx_thread:
                attached_my = bool(user32.AttachThreadInput(my_thread, wx_thread, True))
                
            # 瞬时穿透提升 Z-Order 并切换焦点 (SWP_NOSIZE | SWP_NOMOVE = 0x0003)
            user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0003 | 0x0040)
            user32.SetForegroundWindow(hwnd)
            user32.BringWindowToTop(hwnd)
            user32.SwitchToThisWindow(hwnd, True)
            user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0003)
        finally:
            if attached_cur:
                user32.AttachThreadInput(cur_thread, wx_thread, False)
            if attached_my:
                user32.AttachThreadInput(my_thread, wx_thread, False)
                
        time.sleep(0.03)
        return user32.GetForegroundWindow() == hwnd
    except Exception:
        return False

def restore_user_foreground(orig_hwnd, wx_hwnd):
    """把前台焦点还给用户原窗口：先用原来的普通方式，失败了才用线程输入附加兜底。
    不移动、不缩放任何窗口；还原失败时写一条日志，方便定位。"""
    if not orig_hwnd or orig_hwnd == wx_hwnd:
        return True
    try:
        if not user32.IsWindow(orig_hwnd):
            return False
        user32.SetForegroundWindow(orig_hwnd)          # ① 和原来完全一样的做法
        if user32.GetForegroundWindow() == orig_hwnd:
            return True
        fg = user32.GetForegroundWindow()              # ② 被 Windows 拒绝时才兜底
        fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        my_thread = kernel32.GetCurrentThreadId()
        attached = False
        try:
            if fg_thread and fg_thread != my_thread:
                attached = bool(user32.AttachThreadInput(my_thread, fg_thread, True))
            user32.SetForegroundWindow(orig_hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(my_thread, fg_thread, False)
        time.sleep(0.02)
        ok = (user32.GetForegroundWindow() == orig_hwnd)
        if not ok:
            log("⚠️ [焦点还原失败] 未能把键盘焦点还给原窗口，请点一下你正在用的窗口再继续打字")
        return ok
    except Exception:
        return False

def post_click_client_point(hwnd, client_x, client_y):
    """
    通过 Win32 消息向微信窗口直接发送局部点击消息，
    绝对不调用 SetCursorPos，物理鼠标 1 个像素都不会动！
    """
    try:
        lParam = (int(client_y) << 16) | (int(client_x) & 0xFFFF)
        user32.PostMessageW(hwnd, 0x0200, 0x0000, lParam) # WM_MOUSEMOVE 先更新 Qt 内部悬停控件
        time.sleep(0.01)
        user32.PostMessageW(hwnd, 0x0201, 0x0001, lParam) # WM_LBUTTONDOWN
        time.sleep(0.02)
        user32.PostMessageW(hwnd, 0x0202, 0x0000, lParam) # WM_LBUTTONUP
        time.sleep(0.03)
    except Exception:
        pass

def click_screen_point(x, y):
    """开发版兼容保留函数"""
    pass

# =============================================================================
# 4. HIGH-PERFORMANCE ROBUST NAME MATCHING & RED BADGE FILTER
# =============================================================================
def normalize_for_match(text):
    if not text:
        return ""
    t = str(text).lower().strip()
    t = re.sub(r'\s+', '', t)
    t = t.replace('0', 'o').replace('1', 'l').replace('i', 'l')
    t_clean = re.sub(r'[\^_\~\-\.\,\'\"\`\*\#\@\!\:\;\|\/\\]', '', t)
    return t_clean

def is_group_chat_name(text):
    if not text:
        return False
    t = str(text).strip()
    # 1. 明确包含群聊关键词
    if re.search(r'群聊|交流群|互助群|通知群|工作群|家族群|同乡群|部门群', t):
        return True
    # 2. 名字末尾紧贴括号人数: 如 '吃喝玩乐(25)' 或 '吃喝玩乐（25）'
    name_seg = re.split(r'\s+', t, maxsplit=1)[0]
    if re.search(r'[\(（]\d+[\)）]$', name_seg):
        return True
    # 3. 名字与括号人数带空格: 如 '吃喝玩乐 (25)' 或 '吃喝玩乐 (25) 好的' (第2段纯为括号人数)
    parts = re.split(r'\s+', t)
    if len(parts) >= 2 and re.match(r'^[\(（]\d+[\)）]$', parts[1]):
        return True
    return False

def strip_group_count(name):
    """把 '吃喝玩乐(25)' / '吃喝玩乐（25）' 归一为 '吃喝玩乐'，便于白名单对照。"""
    if not name:
        return ""
    t = str(name).strip()
    t = re.sub(r'[\s]*[\(（]\d+[\)）][\s]*$', '', t)
    return t.strip()

def match_group_whitelist(contact_name, group_whitelist):
    """
    群聊白名单匹配（只在"确认是群"之后调用）。

    左侧会话列表里的一行，OCR 出来通常是：
        "3无敌姐妹1+3(5) @哦鲸鲸说话"     ← 红点数字 + 群名 + 人数 + 消息预览
        "无敌姐妹1+3(5) 还没配好"
    所以不能只做全等比较，必须：
      1) 剥掉行首的红点数字
      2) 剥掉群名末尾的 (人数)
      3) 用"前缀匹配"（群名后面跟的是消息预览）
      4) 全程忽略空白差异（"无敌姐妹 1+3" vs "无敌姐妹1+3"）
    返回 (是否命中, 归一后的群名)
    """
    if not contact_name or not group_whitelist:
        return False, ""

    raw = str(contact_name).strip()
    # 剥行首红点数字："3无敌姐妹1+3(5) ..." -> "无敌姐妹1+3(5) ..."
    raw = re.sub(r'^\d{1,2}(?=[^\d\s])', '', raw).strip()

    # 逐个白名单项做前缀比对
    for g in group_whitelist:
        if not isinstance(g, str) or not g.strip():
            continue
        g_base = strip_group_count(g)
        norm_g = re.sub(r'\s+', '', g_base).lower()
        if not norm_g:
            continue

        # 候选1：整行去掉空白后，看是否以白名单群名开头（忽略其中的 (人数)）
        norm_raw = re.sub(r'\s+', '', raw).lower()
        # 把行内的 "(数字)" 也剥掉再比，避免 "无敌姐妹1+3(5)" 里的人数干扰
        norm_raw_no_count = re.sub(r'[\(（]\d+[\)）]', '', norm_raw)
        if norm_raw_no_count.startswith(norm_g):
            return True, g_base

    return False, ""

def is_group_allowed(contact_name, group_whitelist):
    """
    仅当【命中群白名单】时才放行。
    注意：判定顺序是"先看是否在群白名单里"，而不是"先要求能被识别为群"。
    因为 app 顶栏有时只显示纯群名（不带 (人数)），此时 is_group_chat_name 会返回 False，
    若先要求它成立，会把合法的群挡在门外。
    """
    if not contact_name or not group_whitelist:
        return False, ""
    matched, base = match_group_whitelist(contact_name, group_whitelist)
    if matched:
        return True, base
    return False, ""

def is_name_matched_strict(contact_name, whitelist):
    """
    判断 OCR 出来的一段文本是不是白名单里的某个好友。

    ── 2026-11-04 修：群聊预览行被误认成好友 ──
    左侧会话列表是「标题 / 时间 / 预览」三行一组：
        哦鲸鲸の呱唧          ← 群标题
        16:44               ← 时间
        晨起望秋凉：现在可以了吗   ← 预览（群成员 + 冒号 + 内容）
    原来第 2 条「前缀匹配」把最后那行认成了好友「晨起望秋凉」——
    因为名字后面紧跟的是全角冒号，被当成"标点分隔"放行了。
    结果守护进程以为好友有未读，去点【晨起望秋凉】的会话，
    顶栏却是【哦鲸鲸の呱唧(3)】，纠偏失败 → 熔断 → 一条都发不出去。

    修法：明确识别「名字+冒号」这种群预览格式，一律不当好友。
    同时保留真正的「名字 空格 预览」（如 "张三 好的收到"）。
    """
    if not contact_name or len(str(contact_name).strip()) < 2:
        return False, ""

    c_raw = str(contact_name).strip()

    # ⭐ 群聊预览特征：「某某：内容」。中文冒号或英文冒号都算。
    #    真正的会话标题行不会带冒号（微信标题不含冒号前缀格式）。
    #    这里只在"冒号后面还有内容"时判定，避免误伤名字本身带冒号的极端情况。
    if re.match(r'^[^：:]{1,40}[：:]\s*\S', c_raw):
        return False, ""

    # 红点数字可能被 OCR 并入行首 (如 "3张三")，生成剥离变体一并参与匹配
    raw_variants = [c_raw]
    stripped = re.sub(r'^\d{1,2}(?=[^\d])', '', c_raw).strip()
    if stripped and len(stripped) >= 2 and stripped != c_raw:
        raw_variants.append(stripped)

    for r in raw_variants:
        # 群聊防火墙：精准检测群人数标识 (如 "(25)"、" (25)") 与群关键词，排除消息预览中的量词数字 (如 "(2)楼"、"(5)分")
        if is_group_chat_name(r):
            return False, ""

    for r in raw_variants:
        norm_ocr = normalize_for_match(r)
        if not norm_ocr:
            continue

        for t in whitelist:
            t_clean = t.strip()
            if not t_clean:
                continue

            norm_w = normalize_for_match(t_clean)
            if not norm_w:
                continue
            # 1. 严格全等
            if norm_ocr == norm_w:
                return True, t_clean
            # 2. 前缀精准匹配（例如会话行 "张三 好的收到" / "张三 [图片]" 必须以好友名字开头）
            #    越配防护：原文中名字后紧跟普通字符（字母/数字/汉字，即疑似更长的另一个名字，
            #    如白名单"张三"遇到"张三丰"/"张三丰大碗面"）时一律拒绝命中防止串发；
            #    仅当名字后为空白/标点/结尾（真·名+预览分隔）才放行
            if norm_ocr.startswith(norm_w):
                m = re.match(re.escape(t_clean), r, re.IGNORECASE)
                if m:
                    tail = r[m.end():]
                    if tail and re.match(r'[0-9A-Za-z\u4e00-\u9fff]', tail[0]):
                        continue
                return True, t_clean
            # 3. 极小截断容错（仅当 OCR 极轻微少识别尾部 1 个字符时允许）
            if norm_w.startswith(norm_ocr) and len(norm_w) <= len(norm_ocr) + 1:
                return True, t_clean

    return False, ""

def has_red_badge_by_text_anchor(arr, text_box, layout):
    """
    【高精度动态几何锚定红点算法】：
    以 OCR 识别出的好友名字文字 Box 为基准，自适应覆盖头像右上角红点与数字红圈区域！
    """
    total_w = layout["total_w_px"]
    total_h = layout["total_h_px"]
    
    # 获取联系人文字左边缘与顶部坐标
    txt_left_x = min(pt[0] for pt in text_box)
    txt_top_y = min(pt[1] for pt in text_box)
    
    # 拓宽头像右上角红点与数字红圈采样空间 (txt_left_x - 36 ~ txt_left_x - 3)
    x1 = max(0, int(txt_left_x - 36))
    x2 = max(0, int(txt_left_x - 3))
    y1 = max(0, int(txt_top_y - 20))
    y2 = min(total_h, int(txt_top_y + 20))
    
    patch = arr[y1:y2, x1:x2]
    if patch.size == 0:
        return False
        
    # 微信原生高纯度亮红色判定 (红像素点数 >= 15，转 int 彻底杜绝 uint8 回绕溢出)
    pr, pg, pb = patch[:, :, 0].astype(int), patch[:, :, 1].astype(int), patch[:, :, 2].astype(int)
    red_mask = (pr >= 200) & (pg <= 110) & (pb <= 110) & (pr > pg + 65)
    return np.sum(red_mask) >= 15

def extract_active_chat_title(res, layout):
    """
    顶栏好友昵称提取（Window-Size Invariant）：
    严格锁定在 X >= chat_start_x 且 Y <= header_h，绝不下沉到聊天气泡区。
    """
    chat_start_x = layout["chat_start_x"]
    header_h = layout["header_h"]
    total_w = layout["total_w_px"]
    
    title_candidates = []
    for b, txt, sc in (res or []):
        cx = (b[0][0] + b[1][0]) / 2.0
        cy = (b[0][1] + b[2][1]) / 2.0
        t_clean = txt.strip()
        
        # 严格限制在顶栏左侧区域（排除右上角窗口控制按钮与杂字）
        if (chat_start_x - 30) <= cx <= (chat_start_x + int(0.42 * (total_w - chat_start_x))) and cy <= header_h:
            if t_clean in ["最小化", "最大化", "关闭", "设置", "聊天信息", "搜索", "表情", "发送", "文件", "截图", "语音聊天", "视频聊天", "…", "...", "口", "-", "x", "X"]:
                continue
            title_candidates.append((cx, t_clean))
            
    # 按水平从左到右严格排序，确保分段识别的标题词序绝对正确
    title_candidates.sort(key=lambda x: x[0])
    return " ".join(t for _, t in title_candidates)

# =============================================================================
# 5. CHROMATIC BUBBLE PARSER & MULTI-LINE AGGREGATION
# =============================================================================
BUILTIN_IGNORED_KEYWORDS = [
    "按住鼠标", "长按鼠标", "语音输入文字", "语音输入", "按住说话", "长按说话",
    "按Enter发送", "按Ctrl+Enter发送", "发送(S)", "发送（S）",
    "按住鼠标语音输入", "长按鼠标语音输入",
]

# 微信输入框 / 工具栏的系统占位文案，各版本措辞不同（"按住" vs "长按"、"按Enter" vs "Enter发送"），
# 用模糊规则兜住，避免只差一个字就漏过滤、被当成好友发的消息去回复。
_UI_PLACEHOLDER_RES = [
    re.compile(r'^[长按]?[按住]?鼠标.{0,6}语音输入'),      # 长按鼠标语音输入 / 按住鼠标语音输入
    re.compile(r'^[长按]?[按住]?.{0,4}语音输入(文字)?$'),   # 长按/按住…语音输入(文字)
    re.compile(r'^[长按]?[按住].{0,4}说话$'),              # 长按/按住…说话
    re.compile(r'^按.{0,12}发送$'),                        # 按Enter发送 / 按Ctrl+Enter发送
    re.compile(r'^发送[\(（]S[\)）]$'),                     # 发送(S)
    re.compile(r'^[长按]?[按住]鼠标$'),
]

def is_ui_placeholder(text, all_ignored=None):
    """判断一段 OCR 文本是否为微信界面的占位/提示文案（不是真实聊天内容）。"""
    if not text:
        return False
    t = str(text).strip()
    if not t:
        return False
    # 1. 精确/包含匹配用户与内置词表
    if all_ignored:
        for bad in all_ignored:
            if bad and bad in t:
                return True
    # 2. 模糊规则（应对不同微信版本措辞差异）
    for rx in _UI_PLACEHOLDER_RES:
        if rx.search(t):
            return True
    # 3. 兜底：同时出现"鼠标"和"语音输入"，基本只可能是输入框提示，不可能是聊天内容
    if "鼠标" in t and "语音" in t:
        return True
    return False

def parse_chat_bubbles_chromatic(res, img_rgb, layout, ignored_keywords=None, is_group=False):
    arr = np.array(img_rgb)
    W, H = img_rgb.size
    chat_start_x = layout["chat_start_x"]
    header_h = layout["header_h"]
    input_h = layout["input_h"]
    
    # 汇总系统内置提示词 + 用户自定义屏蔽词
    all_ignored = list(BUILTIN_IGNORED_KEYWORDS)
    if ignored_keywords and isinstance(ignored_keywords, list):
        for kw in ignored_keywords:
            if kw and str(kw).strip() and str(kw).strip() not in all_ignored:
                all_ignored.append(str(kw).strip())
    
    raw_lines = []
    for b, txt, sc in (res or []):
        cx = (b[0][0] + b[1][0]) / 2.0
        cy = (b[0][1] + b[2][1]) / 2.0
        c_clean = txt.strip()
        if not c_clean:
            continue
            
        # 排除系统原生 UI 提示词与屏蔽词
        # 微信各版本措辞不同（"按住鼠标" / "长按鼠标语音输入"），直接用包含匹配会漏，
        # 因此统一交给 is_ui_placeholder 做模糊判定。
        if is_ui_placeholder(c_clean, all_ignored):
            continue
            
        # 排除顶栏乱码与非聊天文字 (纯数字如 666, 1, 520, 21 等 100% 完整保留支持)
        if any(bad in c_clean for bad in ["P以H白", "y< o O", "查看更多", "以下为新消息", "置顶聊天"]):
            continue
        
        # 严格限定在主聊天气泡区域 (顶部避开标题栏 + 15px，底部避开输入工具栏)
        # ★ 底部边界收紧到输入框上沿：微信 4.x 的输入框占位文案与输入工具栏位置比旧版更高，
        # 原来 input_h*0.70 的余量会把输入框提示词算进气泡区，导致把提示词当成好友消息。
        if cx > (chat_start_x + 15) and (header_h + 15) < cy < (H - input_h - 10):
            if re.match(r'^\d{1,2}:\d{2}$', c_clean) or re.match(r'^\d{1,2}/\d{2}$', c_clean) or re.match(r'^\d{4}-\d{2}-\d{2}', c_clean):
                continue
            if c_clean in ["昨天", "前天", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日", "查看更多消息", "重新编辑", "发送"]:
                continue
            if any(c_clean.startswith(p) for p in ["[转账]", "微信转账", "已收款", "已被接收", "￥", "你撤回了一条消息"]):
                continue
            if "拍了拍" in c_clean:
                continue
                
            # 采样气泡底色 (外扩采样)
            min_x = max(0, int(min(pt[0] for pt in b) - 15))
            max_x = min(W, int(max(pt[0] for pt in b) + 15))
            min_y = max(0, int(min(pt[1] for pt in b) - 8))
            max_y = min(H, int(max(pt[1] for pt in b) + 8))
            
            patch = arr[min_y:max_y, min_x:max_x]
            pr, pg, pb = patch[:, :, 0].astype(int), patch[:, :, 1].astype(int), patch[:, :, 2].astype(int)
            green_mask = (pg > pr + 18) & (pg > pb + 18) & (pg > 45)
            has_green_bg = np.sum(green_mask) > 15
            
            box_left = min(pt[0] for pt in b)
            box_right = max(pt[0] for pt in b)
            
            # 真彩底色判定：绿底 100% 我发，非绿底偏左侧 100% 好友发
            is_incoming = (not has_green_bg) and (box_left < (chat_start_x + int(0.55 * (W - chat_start_x))))
            raw_lines.append((cy, box_left, box_right, is_incoming, c_clean))
            
    raw_lines.sort(key=lambda x: x[0])
    
    # 智能多行气泡垂直合并 (< 40px)
    merged_bubbles = []
    for cy, b_left, b_right, is_inc, text in raw_lines:
        if merged_bubbles and is_inc == merged_bubbles[-1]['is_incoming'] and abs(cy - merged_bubbles[-1]['last_y']) < 40:
            merged_bubbles[-1]['text'] += "，" + text
            merged_bubbles[-1]['last_y'] = cy
        else:
            merged_bubbles.append({
                'is_incoming': is_inc,
                'first_y': cy,
                'last_y': cy,
                'text': text
            })

    # ---------------------------------------------------------------------
    # 群聊专项清洗：微信群里每条对方消息的【上方】会显示发言人昵称（小字、单行）。
    # 原逻辑只按绿底/非绿底区分，会把昵称当成消息正文拼进去，导致 AI 读到
    # "AAA跨境运营小王子，还没配好，AAA跨境运营小王子，牌没有问题" 这种鬼东西。
    # 这里用两个特征把昵称行剔掉：
    #   1) 该行与上一行同属"对方"且垂直间距明显大于行内间距（昵称在气泡上方独立成行）
    #   2) 该行文本很短、且后面紧跟的同类文本才是真正内容
    # ---------------------------------------------------------------------
    if is_group and merged_bubbles:
        cleaned = []
        for idx, bub in enumerate(merged_bubbles):
            if not bub['is_incoming']:
                cleaned.append(bub)
                continue

            # 猜测：短文本 + 位于下一个对方气泡正上方(< 42px) => 认为是昵称行
            txt = bub['text']
            is_short = len(txt) <= 20 and '，' not in txt and '\n' not in txt
            next_in = None
            for j in range(idx + 1, len(merged_bubbles)):
                if merged_bubbles[j]['is_incoming']:
                    next_in = merged_bubbles[j]
                    break
                break
            gap = (next_in['first_y'] - bub['last_y']) if next_in else 999

            # 昵称通常紧贴气泡上方（间距 10~45px），且自身字数少
            if is_short and 0 < gap <= 45:
                # 作为发言人记录下来，不进入正文
                cleaned.append(dict(bub, is_sender_name=True, sender_name=txt, text=""))
                continue
            cleaned.append(bub)

        # 合并"发言人 + 其内容"，把昵称挂到该条消息上，正文只留内容
        merged_bubbles = []
        pending_sender = ""
        for bub in cleaned:
            if bub.get('is_sender_name'):
                pending_sender = bub['sender_name'].strip()
                continue
            if pending_sender and bub['is_incoming']:
                bub = dict(bub)
                bub['sender_name'] = pending_sender
                pending_sender = ""
            merged_bubbles.append(bub)

        # 丢掉清洗后变空的气泡
        merged_bubbles = [b for b in merged_bubbles if b.get('text', '').strip()]

    return merged_bubbles

def extract_pending_incoming_messages(chat_bubbles):
    """
    夹层未读穿透回溯算法 (Bubble Penetration Scanner):
    寻找最后一条我方绿底气泡 (last_outgoing_idx)，
    将其下方所有的好友连发气泡全部完整聚合提取！
    """
    if not chat_bubbles:
        return [], ""
        
    last_outgoing_idx = -1
    for i in range(len(chat_bubbles) - 1, -1, -1):
        if not chat_bubbles[i]['is_incoming']:
            last_outgoing_idx = i
            break
            
    if last_outgoing_idx == -1:
        pending_bubbles = [b for b in chat_bubbles if b['is_incoming']]
    else:
        pending_bubbles = [b for b in chat_bubbles[last_outgoing_idx + 1:] if b['is_incoming']]
        
    texts = []
    for b in pending_bubbles:
        t = b['text'].strip()
        if not t:
            continue
        sender_name = (b.get('sender_name') or '').strip()
        if sender_name:
            # 群聊：带上发言人，AI 才知道是谁在说
            texts.append(f"{sender_name}：{t}")
        else:
            texts.append(t)
    combined_text = "，".join(texts)
    return pending_bubbles, combined_text

# =============================================================================
# 6. LLM BRAIN & INSTANT PURE TEXT GENERATION (0 ARTIFICIAL LATENCY)
# =============================================================================
def clean_ai_reply(reply):
    if not reply:
        return ""
    reply = re.sub(r'<think>.*?</think>', '', reply, flags=re.DOTALL)
    reply = re.sub(r'^[（(][^）)]*[）)]\s*', '', reply)
    reply = re.sub(r'\s*[（(][^）)]*[）)]$', '', reply)
    reply = re.sub(r'[*_#`]', '', reply)
    reply = reply.strip()
    if reply.startswith(('"', '“')) and reply.endswith(('"', '”')):
        reply = reply[1:-1].strip()
    return reply

def generate_ai_reply(sender, message_content, is_group=False):
    cfg = load_config()
    now_time = time.strftime("%H:%M")

    # 群聊与私聊各用一套独立人设（互不影响）：
    #   system_prompt       / friend_personas  -> 私聊
    #   group_system_prompt / group_personas   -> 群聊
    # 旧配置里只有 system_prompt 时，群聊会回落到它，保证向后兼容。
    private_prompt = (cfg.get("system_prompt") or "").strip()
    group_prompt = (cfg.get("group_system_prompt") or "").strip()

    if is_group:
        persona_desc = ((cfg.get("group_personas") or {}).get(sender) or "").strip()
        base_prompt = group_prompt or private_prompt
        scene_rule = (
            f"你现在是微信群「{sender}」里的一员（真实本人，不是机器人）。当前时间{now_time}。\n"
            "【对话规则】直接输出一条要发到群里的中文消息，简短自然、口语化，不要@任何人。\n"
            "严禁自称AI或机器人，严禁括号描写心理活动，严禁输出解释或markdown格式。"
        )
        if persona_desc:
            scene_rule += f"\n【本群的互动风格】：{persona_desc}"
        system_prompt = (base_prompt + "\n" + scene_rule) if base_prompt else scene_rule
    else:
        persona_desc = ((cfg.get("friend_personas") or {}).get(sender) or "").strip()
        base_prompt = private_prompt
        if base_prompt:
            if persona_desc:
                system_prompt = (
                    f"{base_prompt}\n"
                    f"【当前互动好友】：好友【{sender}】，当前时间{now_time}。\n"
                    f"【该好友专属人设】：{persona_desc}\n"
                    f"【对话规则】：直接输出发给对方的一句中文，口语化自然、简练得体。严禁括号描写心理活动，严禁透露AI身份。"
                )
            else:
                system_prompt = (
                    f"{base_prompt}\n"
                    f"【当前互动好友】：好友【{sender}】，当前时间{now_time}。\n"
                    f"【对话规则】：直接输出发给对方的一句中文，口语化自然、简练得体。严禁括号描写心理活动，严禁透露AI身份。"
                )
        else:
            fallback_persona = persona_desc or "幽默风趣、随和自然的真实好友"
            system_prompt = (
                f"你现在是微信账号的主人本人（真实真人），正在微信上与好友【{sender}】聊天。当前时间是{now_time}。\n"
                f"【专属人设风格】：{fallback_persona}\n"
                f"【对话规则】：直接输出发给对方的一句中文，口语化自然、简练得体。严禁括号描写心理活动，严禁透露AI身份。"
            )
    
    oa = cfg.get("openai_api") or {}
    api_base = str(cfg.get("api_url") or oa.get("api_base") or "https://api.xiaomimimo.com/v1").strip().rstrip("/")
    url = api_base if api_base.endswith("/chat/completions") else f"{api_base}/chat/completions"
    key = cfg.get("api_key") or oa.get("api_key") or ""
    model = cfg.get("api_model") or oa.get("model") or "mimo-v2.6-flash"
    temperature = cfg_float(oa, "temperature", 0.7)
    
    if not key or not url:
        log("⚠️ [未配置 API Key] 未检测到 API Key，跳过自动回复。请先在控制中心【AI 引擎设置】中配置有效 Key！")
        return ""
        
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    history = API_CONVERSATION_HISTORY.get(sender, [])
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history[-8:])
    messages.append({"role": "user", "content": message_content})
    
    payload = {"model": model, "messages": messages, "temperature": temperature}
    try:
        log(f"🤖 正在调用大模型 ({model}) 回复【{sender}】...")
        res = requests.post(url, headers=headers, json=payload, timeout=12)
        # 部分中转站返回 Content-Type: text/event-stream（或不带 charset），
        # requests 会退回 ISO-8859-1 解码，导致中文变成 å\x9c¨ 这类乱码。强制 UTF-8。
        res.encoding = "utf-8"
        if res.status_code == 200:
            reply = res.json()["choices"][0]["message"]["content"]
            cleaned = clean_ai_reply(reply)
            history.append({"role": "user", "content": message_content})
            history.append({"role": "assistant", "content": cleaned})
            API_CONVERSATION_HISTORY[sender] = history[-10:]
            return cleaned
        else:
            log(f"⚠️ [API HTTP {res.status_code}] {res.text[:100]}")
    except Exception as e:
        log(f"⚠️ [API 请求异常] {e}")
        
    return ""

def count_green_bubble_metrics(img, layout):
    """
    计算聊天视窗底部两个关键特征带的绿底像素分布：
    1. tot_green: 底部 220px 偏右侧整体绿底像素总数
    2. bot_green: 最贴近输入框的最后 80px 窄带右侧绿底像素数（最新发出气泡必定落入此区域）
    """
    if not img:
        return 0, 0
    try:
        W, H = img.size
        arr_v = np.array(img)
        chat_start_x = layout["chat_start_x"]
        input_h = layout["input_h"]
        
        # 区域 1: 底部 220px 整体监控区 (从 0.35 偏移起，严格锚定右侧我方气泡轨，杜绝对方发绿色表情包的干扰)
        y1_tot = max(0, int(H - input_h - 220))
        y2_tot = min(H, int(H - input_h + 10))
        x1_tot = int(chat_start_x + 0.35 * (W - chat_start_x))
        x2_tot = min(W, int(W - 10))
        
        patch_tot = arr_v[y1_tot:y2_tot, x1_tot:x2_tot]
        tot_green = 0
        if patch_tot.size > 0:
            pr = patch_tot[:, :, 0].astype(int)
            pg = patch_tot[:, :, 1].astype(int)
            pb = patch_tot[:, :, 2].astype(int)
            mask_tot = (pg > pr + 18) & (pg > pb + 18) & (pg > 45)
            tot_green = int(np.sum(mask_tot))
            
        # 区域 2: 贴底 80px 最新气泡锚定区 (只监控最下方刚长出的新气泡)
        y1_bot = max(0, int(H - input_h - 80))
        y2_bot = min(H, int(H - input_h))
        x1_bot = int(chat_start_x + 0.35 * (W - chat_start_x))
        x2_bot = min(W, int(W - 20))
        
        patch_bot = arr_v[y1_bot:y2_bot, x1_bot:x2_bot]
        bot_green = 0
        if patch_bot.size > 0:
            pr_b = patch_bot[:, :, 0].astype(int)
            pg_b = patch_bot[:, :, 1].astype(int)
            pb_b = patch_bot[:, :, 2].astype(int)
            mask_bot = (pg_b > pr_b + 18) & (pg_b > pb_b + 18) & (pg_b > 45)
            bot_green = int(np.sum(mask_bot))
            
        return tot_green, bot_green
    except Exception:
        return 0, 0

def verify_diff_bubble_success(img_pre, img_post, layout):
    """
    【严谨差分动态绿底增量闭环验收引擎（三态架构）】：
    返回值三态：
      True: 明确成功（差分检测到新长出的绿底气泡增量）
      False: 明确失败（画面清晰但确实未检测到新绿底增量，允许进入受控重试）
      "UNCERTAIN": 无法判定（截图异常、画面全黑或 DWM 离屏抓取受阻，安全熔断终止重试以防重复发送）
    """
    if not img_pre or not img_post:
        return "UNCERTAIN"
    try:
        arr_pre = np.array(img_pre)
        arr_post = np.array(img_post)
        if arr_pre.max() <= 10 or arr_post.max() <= 10:
            return "UNCERTAIN"
    except Exception:
        return "UNCERTAIN"

    pre_tot, pre_bot = count_green_bubble_metrics(img_pre, layout)
    post_tot, post_bot = count_green_bubble_metrics(img_post, layout)
    
    # 判定规则：满足任一合法增量特征即证明新气泡生成
    has_bottom_anchor_spawn = (post_bot >= 40 and (post_bot - pre_bot) >= 30)
    has_total_green_growth = ((post_tot - pre_tot) >= 50)
    
    if has_bottom_anchor_spawn or has_total_green_growth:
        return True

    # ★ 兜底判据（微信 4.x 布局变化后，上面按 input_h 推算的固定绿底区域可能测不准，
    #    导致消息其实已发出却判为失败，进而引发重复发送）：
    # 聊天区整体像素变化足够大 => 认为确实发出了新内容。
    try:
        chat_y1 = int(layout["header_h"] + 15)
        chat_y2 = int(arr_post.shape[0] - layout["input_h"])
        chat_x1 = int(layout["chat_start_x"] + 15)
        if chat_y2 > chat_y1 and arr_post.shape[1] > chat_x1:
            a = arr_pre[chat_y1:chat_y2, chat_x1:, :3].astype(int)
            b = arr_post[chat_y1:chat_y2, chat_x1:, :3].astype(int)
            if a.shape == b.shape and a.size > 0:
                diff = np.abs(a - b)
                changed = int(np.sum(np.max(diff, axis=2) > 25))
                total = a.shape[0] * a.shape[1]
                ratio = changed / float(total) if total else 0.0
                # 一条新消息气泡通常会改动聊天区 0.15% 以上像素；低于此视为画面没动
                if changed >= 800 and ratio >= 0.0015:
                    return True
    except Exception:
        pass

    return False

def safe_clipboard_copy(text, retries=3, delay=0.03):
    """
    带冲突退避重试的剪贴板安全写入函数：
    有效化解 Windows 剪贴板历史 (Win+V)、杀软或浏览器占用导致的 OpenClipboard 冲突。
    """
    for i in range(retries):
        try:
            pyperclip.copy(text)
            return True
        except Exception:
            if i < retries - 1:
                time.sleep(delay)
    return False

def send_reply_instant(hwnd, rect, layout, target, final_reply, is_group=False):
    """
    极速秒回直达引擎（局部消息投递，0 弹窗 0 鼠标物理移动）：
    1. 预检当前顶栏目标并智能纠偏
    2. 剪贴板安全原子写入
    3. Win32 穿透提权与击键前前台强校验 (必须 GetForegroundWindow() == hwnd，绝不盲发按键防串窗)
    4. 动态自适应几何坐标模拟点击输入框聚焦 (0 鼠标物理移动)
    5. Ctrl+V 与 Enter 极速注入
    6. 平稳切回用户原窗口 (彻底废除 HWND_BOTTOM 压底)
    7. 动态差分绿底增量严谨闭环验收

    is_group=True 时，顶栏核对走"群名归一对照"，避免 (25) 人数后缀导致核对失败熔断。
    """
    def _title_matches(title):
        if not title:
            return False
        if is_group:
            # 群名对照：剥掉括号人数、去掉所有空白后比对
            # （OCR 出来的 "无敌姐妹1+3(5)" 与白名单 "无敌姐妹 1+3" 只差一个空格，
            #   直接用字符串相等会误判失败，必须归一化）
            a = re.sub(r'\s+', '', strip_group_count(title)).lower()
            b = re.sub(r'\s+', '', strip_group_count(target)).lower()
            if a and b and a == b:
                return True
            return match_group_whitelist(title, [target])[0]
        return is_name_matched_strict(title, [target])[0]
    # --- 发送前核验 (Pre-Flight Verification) ---
    img_now, cur_rect, cur_scale = grab_wechat_window(hwnd)
    if not img_now:
        log(f"⚠️ [发送前核验失败] 无法获取微信画面，终止发送防误触")
        return False
        
    cur_W, cur_H = img_now.size
    cur_layout = compute_wechat_layout(cur_W, cur_H)
    
    # 极速轻量 OCR 顶栏与左侧列表
    target_w = 1000
    downscale_ratio = 1000.0 / cur_W if cur_W > 1100 else 1.0
    if downscale_ratio < 1.0:
        img_for_ocr = img_now.resize((target_w, int(cur_H * downscale_ratio)), Image.Resampling.BILINEAR)
        res_raw, _ = ocr_engine(img_for_ocr)
        res_now = []
        for b, txt, sc in (res_raw or []):
            mapped_box = [[pt[0] / downscale_ratio, pt[1] / downscale_ratio] for pt in b]
            res_now.append((mapped_box, txt, sc))
    else:
        res_now, _ = ocr_engine(img_now)
        
    cur_title = extract_active_chat_title(res_now, cur_layout)
    is_right_target = _title_matches(cur_title)
    
    # 若顶栏不是目标好友，触发智能重定向
    if not is_right_target:
        log(f"⚠️ [发送前纠偏] 检测到窗口偏离（当前为【{cur_title or '非目标'}】），正在重定向锁定【{target}】...")
        found_cand_y = None
        sidebar_w = cur_layout["sidebar_w"]
        chat_start_x = cur_layout["chat_start_x"]
        for b, txt, sc in (res_now or []):
            cx = (b[0][0] + b[1][0]) / 2.0
            cy = (b[0][1] + b[2][1]) / 2.0
            if sidebar_w <= cx <= chat_start_x and (cur_layout["header_h"] + 5) <= cy <= (cur_H - 20):
                if _title_matches(txt.strip()):
                    found_cand_y = cy
                    break
                    
        if found_cand_y is not None:
            # 点击横幅中心：必须由 layout 推导，不能写死比例。
            # 群聊行比好友行高、红点让行宽也变，固定 0.16*W 会点偏 → 顶栏不符 → 熔断。
            post_click_client_point(hwnd, sidebar_row_click_x(cur_layout), int(found_cand_y))
            time.sleep(0.30)  # 等待 Qt5 完成右侧视窗切换渲染
            # 🔥 纠偏后二次核验：重新抓图 OCR 顶栏，绝不盲信点击一定生效（防串发红线）
            img_chk, _, _ = grab_wechat_window(hwnd)
            if not img_chk:
                log(f"🚫 [安全熔断] 纠偏后无法抓图复核顶栏，放弃本次发送防串发！")
                return False
            chk_W, chk_H = img_chk.size
            chk_layout = compute_wechat_layout(chk_W, chk_H)
            hdr = img_chk.crop((0, 0, chk_W, int(chk_layout["header_h"] + 15)))
            res_hdr_raw, _ = ocr_engine(hdr)
            res_hdr = [([[pt[0], pt[1]] for pt in b], txt, sc) for b, txt, sc in (res_hdr_raw or [])]
            chk_title = extract_active_chat_title(res_hdr, chk_layout)
            if not _title_matches(chk_title):
                log(f"🚫 [安全熔断] 纠偏后顶栏仍为【{chk_title or '非目标'}】，点击未生效，放弃本次发送防串发！")
                return False
            log(f"🎯 [后台静默纠偏] 已重新切入【{target}】聊天视窗（顶栏复核通过）")
        else:
            log(f"🚫 [安全熔断] 未在列表中定位到目标【{target}】，放弃本次发送以防串发！")
            return False
            
    log(f"📤 正在回复【{target}】: {final_reply}")
    
    # 剪贴板原子快照保护
    user_old_clip = None
    try:
        user_old_clip = pyperclip.paste()
    except Exception:
        pass
        
    user_orig_hwnd = user32.GetForegroundWindow()
    send_success = False
    send_unverified = False
    
    for attempt in range(1, 3):
        # 1. 剪贴板安全写入
        if not safe_clipboard_copy(final_reply, retries=3, delay=0.03):
            log(f"⚠️ [剪贴板写入受阻(尝试 {attempt}/2)] 系统剪贴板被占用，稍后重试...")
            time.sleep(0.05)
            continue
        time.sleep(0.02)
        
        # 2. 发送前基线图像抓取 (用于差分验收)
        img_pre, _, _ = grab_wechat_window(hwnd)
        
        # 3. Win32 穿透提权激活微信
        activate_wechat(hwnd)
        time.sleep(0.03)
        
        # 🔥 关键安全红线：击键前强校验前台窗口！
        cur_fore = user32.GetForegroundWindow()
        if cur_fore != hwnd:
            log(f"🚫 [安全熔断(尝试 {attempt}/2)] 微信窗口未夺取到前台焦点 (当前前台HWND={cur_fore})，坚决终止按键模拟防串窗！")
            time.sleep(0.15)
            continue
            
        # 4. 动态自适应几何坐标模拟点击输入框聚焦 (0 鼠标物理移动)
        # 根据动态高度与 input_h 计算垂直安全中心，避开底部图标栏与顶部视窗分割线
        input_safe_y = int(cur_H - cur_layout["input_h"] * 0.55)
        input_safe_x = int(0.55 * cur_W)
        post_click_client_point(hwnd, input_safe_x, input_safe_y)
        time.sleep(0.03)
        
        # 二次复验前台归属
        if user32.GetForegroundWindow() != hwnd:
            log(f"🚫 [安全熔断(尝试 {attempt}/2)] 点击输入框时光标脱失，终止击键！")
            continue
            
        # 5. 极速键盘事件注入 (Ctrl+V 与 Enter)
        try:
            # Ctrl+V 粘贴
            user32.keybd_event(0x11, 0, 0, 0)
            user32.keybd_event(0x56, 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(0x56, 0, 0x0002, 0)
            user32.keybd_event(0x11, 0, 0x0002, 0)
            time.sleep(0.04)
            
            # 回车发送
            user32.keybd_event(0x0D, 0, 0, 0)
            time.sleep(0.02)
            user32.keybd_event(0x0D, 0, 0x0002, 0)
            time.sleep(0.04)
        finally:
            # 6. 平稳恢复用户原本的前台窗口 (坚决废除 HWND_BOTTOM 压底！)
            restore_user_foreground(user_orig_hwnd, hwnd)
                
        # 7. 渲染沉降与严谨差分动态绿底增量闭环验收
        time.sleep(0.35) # 等待微信 Qt5 气泡动画与排版彻底沉降
        img_post, _, _ = grab_wechat_window(hwnd)
        verdict = verify_diff_bubble_success(img_pre, img_post, cur_layout)
        if verdict is True:
            send_success = True
            break
        elif verdict == "UNCERTAIN":
            log(f"⚠️ [闭环验收异常] 离屏画面抓取受阻无法比对，安全熔断终止重试以防向好友【{target}】重复发消息！")
            send_success = True
            send_unverified = True
            break
        else:
            # ★ 防重复发送红线：键已注入过（Ctrl+V 与 Enter 都发了），此时"验收未通过"更可能是
            #   判定阈值/布局不适配，而不是真的没发出去。宁可少发一条，也不能重复骚扰好友。
            log(f"⚠️ [发送闭环验收未通过(尝试 {attempt}/2)] 未检测到新绿底气泡增量。"
                f"但按键已注入，为避免重复发送，不再重试，按「已发出但未验证」处理。")
            send_success = True
            send_unverified = True
            break
            
    # 还原用户原本的剪贴板 (仅当原剪贴板为非空文本时写回，避免冲掉用户复制的图片/文件)
    if user_old_clip:
        safe_clipboard_copy(user_old_clip, retries=2, delay=0.02)
        
    if send_success and send_unverified:
        log(f"⚠️ [发送未验证] 已按发出处理并登记防重复，但未能抓图验证好友【{target}】是否收到，请留意确认！")
    elif send_success:
        log(f"✅ [后台静默秒回成功] 已回复【{target}】！(物理鼠标 0 移动，瞬态焦点已复原)")
    else:
        log(f"❌ [发送脱靶告警] 2 次重试后均未检测到绿底气泡增量！")
        
    return send_success

# =============================================================================
# 7. 左右双轨协同感知引擎 (DUAL-TRACK COLLABORATIVE ENGINE)
# =============================================================================
def scan_and_reply_wechat(hwnd):
    global LAST_CHAT_HASH, LAST_SIDEBAR_HASH, LAST_FULL_SCAN_TIME
    ensure_default_desktop()
    cfg = load_config()
    
    img_wechat, rect, scale = grab_wechat_window(hwnd)
    if not img_wechat:
        return
        
    W, H = img_wechat.size
    if W <= 100 or H <= 100:
        return
        
    layout = compute_wechat_layout(W, H)
    arr_wechat = np.array(img_wechat)
    
    # -------------------------------------------------------------------------
    # ⚡ 像素级动态感知哨兵 (Pixel Sentinel: 20ms 极速变动感知，消灭 18s OCR 空转)
    # -------------------------------------------------------------------------
    crop_x1 = max(330, int(layout["chat_start_x"] + 10))
    crop_y1 = max(0, int(layout["header_h"] + 10))
    crop_x2 = min(W, int(W - 5))
    crop_y2 = min(H, int(H - int(layout["input_h"] * 0.70)))
    
    chat_patch = arr_wechat[crop_y1:crop_y2, crop_x1:crop_x2]
    curr_chat_hash = hashlib.md5(chat_patch.tobytes()).hexdigest()
    
    sidebar_patch = arr_wechat[:, :layout["chat_start_x"]]
    sr, sg, sb = sidebar_patch[:, :, 0].astype(int), sidebar_patch[:, :, 1].astype(int), sidebar_patch[:, :, 2].astype(int)
    red_mask = (sr >= 190) & (sg <= 115) & (sb <= 115) & (sr > sg + 55)
    has_red_pixels = np.sum(red_mask) >= 15
    
    curr_sidebar_hash = hashlib.md5(sidebar_patch.tobytes()).hexdigest()
    now_ts = time.time()
    
    # 若画面未发生任何像素改变、无红点且距离上次扫描 < 1.0 秒：直接 20ms 极速放行！
    if curr_chat_hash == LAST_CHAT_HASH and curr_sidebar_hash == LAST_SIDEBAR_HASH and not has_red_pixels and (now_ts - LAST_FULL_SCAN_TIME) < 1.0:
        return
        
    LAST_CHAT_HASH = curr_chat_hash
    LAST_SIDEBAR_HASH = curr_sidebar_hash
    LAST_FULL_SCAN_TIME = now_ts
    
    # 动态下采样加速 OCR (等比下采样至 1000 宽，耗时从 5.5s 降至 0.8s)
    target_w = 1000
    downscale_ratio = 1000.0 / W if W > 1100 else 1.0
    if downscale_ratio < 1.0:
        target_h = int(H * downscale_ratio)
        img_for_ocr = img_wechat.resize((target_w, target_h), Image.Resampling.BILINEAR)
        res_raw, _ = ocr_engine(img_for_ocr)
        res = []
        for b, txt, sc in (res_raw or []):
            mapped_box = [[pt[0] / downscale_ratio, pt[1] / downscale_ratio] for pt in b]
            res.append((mapped_box, txt, sc))
    else:
        res, _ = ocr_engine(img_wechat)
        
    if not res:
        return
        
    whitelist_mode = cfg.get("whitelist_mode", True)
    whitelist = [w for w in (cfg.get("whitelist") or []) if isinstance(w, str)]
    # 群聊白名单：默认空 = 完全保持原有行为（群聊一律不回）
    group_whitelist = [g for g in (cfg.get("group_whitelist") or []) if isinstance(g, str)]
    is_group_target = False
    blacklist = [b for b in (cfg.get("blacklist") or []) if isinstance(b, str)]
    ignored_keywords = cfg.get("ignored_keywords", [])

    def is_valid_non_whitelist_target(name_str):
        if not name_str or len(str(name_str).strip()) < 2:
            return False
        n = str(name_str).strip()
        if any(b_name in n for b_name in blacklist if b_name.strip()):
            return False
        # 群聊防火墙：精准检测群人数标识 (如 "(25)"、" (25)") 与群关键词，排除消息预览中的量词数字 (如 "(2)楼"、"(5)分")
        if is_group_chat_name(n):
            return False
        if n in ["微信", "搜索", "文件传输助手", "朋友圈", "订阅号", "服务通知", "腾讯新闻"]:
            return False
        return True
    
    sidebar_w = layout["sidebar_w"]
    chat_start_x = layout["chat_start_x"]
    
    # -------------------------------------------------------------------------
    # 轨 1: 左侧会话全局看板 (提取高浓度绿色激活项 & 红点列表)
    # -------------------------------------------------------------------------
    session_items = []
    for b, txt, sc in res:
        cx = (b[0][0] + b[1][0]) / 2.0
        cy = (b[0][1] + b[2][1]) / 2.0
        if sidebar_w <= cx <= chat_start_x and (layout["header_h"] + 5) <= cy <= (layout["total_h_px"] - 20):
            session_items.append((cy, cx, txt.strip(), b))
            
    session_items.sort(key=lambda x: x[0])
    
    active_green_text = None
    max_green_count = 0
    red_badge_candidates = []
    
    for cy, cx, text_clean, b in session_items:
        if any(b_name in text_clean for b_name in blacklist if b_name.strip()):
            continue
            
        # 统计该行绿色像素强度 (寻找真正被激活的会话，转 int 杜绝浅色背景回绕溢出)
        min_y = max(0, int(cy - 18))
        max_y = min(H, int(cy + 18))
        patch = arr_wechat[min_y:max_y, sidebar_w:chat_start_x]
        pr, pg, pb = patch[:, :, 0].astype(int), patch[:, :, 1].astype(int), patch[:, :, 2].astype(int)
        green_pixels = np.sum((pg > pr + 25) & (pg > pb + 25) & (pg > 80))
        
        if green_pixels > 1200 and green_pixels > max_green_count:
            max_green_count = green_pixels
            active_green_text = text_clean
            
        # 判定是否有新消息红点 (基于文字动态几何锚定)
        # ★ 群聊优先：左侧列表里出现群名时，先看是否在 group_whitelist 中，
        #   否则 is_name_matched_strict 会因为"这是群"直接拒绝，导致群红点永远进不了候选，
        #   表现为"群里来新消息完全没反应"。
        cand_target = None
        matched = False
        _g_ok, _g_name = is_group_allowed(text_clean, group_whitelist)
        if _g_ok:
            matched = True
            cand_target = _g_name
        elif whitelist_mode:
            matched, cand_target = is_name_matched_strict(text_clean, whitelist)
        else:
            matched = is_valid_non_whitelist_target(text_clean)
            # 提取纯净的好友昵称（剥离行首红点计数与尾部消息预览）
            clean_name = re.sub(r'^\d{1,2}(?=[^\d])', '', text_clean).strip()
            cand_target = re.split(r'\s+', clean_name, maxsplit=1)[0].strip()
        if matched and cand_target and has_red_badge_by_text_anchor(arr_wechat, b, layout):
            red_badge_candidates.append((cy, cand_target))
                
    # -------------------------------------------------------------------------
    # 轨 2: 右侧微观聊天区 (提取顶栏标题 & 消息气泡)
    # -------------------------------------------------------------------------
    active_right_title = extract_active_chat_title(res, layout)
    
    # -------------------------------------------------------------------------
    # 🌟 会话目标识别与门禁 (Whitelist Gating / Non-Whitelist Firewall)
    # -------------------------------------------------------------------------
    current_active_target = None
    
    if whitelist_mode:
        # 白名单模式：必须精准命中白名单中的指定好友
        # ★ 群聊优先判定：只有显式列进 group_whitelist 的群才放行，其余群一律照旧拦截
        if active_right_title:
            allowed_g, g_name = is_group_allowed(active_right_title, group_whitelist)
            if allowed_g:
                current_active_target = g_name
                is_group_target = True
        if not current_active_target and active_green_text:
            allowed_g, g_name = is_group_allowed(active_green_text, group_whitelist)
            if allowed_g:
                current_active_target = g_name
                is_group_target = True

        if not current_active_target and active_right_title:
            matched_right, right_target = is_name_matched_strict(active_right_title, whitelist)
            if matched_right:
                current_active_target = right_target
                
        if not current_active_target and active_green_text:
            matched_left, left_target = is_name_matched_strict(active_green_text, whitelist)
            if matched_left:
                current_active_target = left_target
    else:
        # 非白名单模式：允许回复普通单人好友，强制过滤黑名单、服务号与群聊
        # ★ 群聊白名单同样优先：显式允许的群照常回复
        if active_right_title:
            allowed_g, g_name = is_group_allowed(active_right_title, group_whitelist)
            if allowed_g:
                current_active_target = g_name
                is_group_target = True
        if not current_active_target and active_green_text:
            allowed_g, g_name = is_group_allowed(active_green_text, group_whitelist)
            if allowed_g:
                current_active_target = g_name
                is_group_target = True

        if not current_active_target and active_right_title and is_valid_non_whitelist_target(active_right_title):
            current_active_target = active_right_title.strip()
        elif not current_active_target and active_green_text and is_valid_non_whitelist_target(active_green_text):
            clean_green = re.sub(r'^\d{1,2}(?=[^\d])', '', active_green_text).strip()
            current_active_target = re.split(r'\s+', clean_green, maxsplit=1)[0].strip()
    
    if current_active_target:
        chat_bubbles = parse_chat_bubbles_chromatic(res, img_wechat, layout, ignored_keywords, is_group=is_group_target)
        if chat_bubbles:
            pending_bubbles, combined_text = extract_pending_incoming_messages(chat_bubbles)
            # 🔥 第一道铁闸：只要当前好友有未回复新消息，绝对锁定在当前窗口就地秒回！
            if pending_bubbles and combined_text:
                # ── 2026-11-04 修：签名不能带像素坐标，否则同一条消息会被反复上报 ──
                # 原来：
                #   current_sig = (target, combined_text, int(pending[-1]['last_y']), len(bubbles))
                # last_y 是气泡的像素纵坐标，OCR 每轮抖动 ±1px 就变一次签名，
                # 于是同一条消息被无限重复上报（用户看到"一直在识别私聊和群聊"）。
                # 而且一旦回复后气泡滚动，last_y 全变，历史消息会再触发一遍。
                #
                # 现在：只留「谁 + 说了什么」。这才是"这条消息处理过没有"的真正依据。
                # 连发聚合时 combined_text 本身就是稳定的（多句拼接结果一致）。
                current_sig = (current_active_target, combined_text)
                # 两道闸，都带时间窗（默认 12 秒）：
                #   ① 签名相同    = 这条内容刚处理过 → 跳过
                #   ② 文本等于最后处理的那句 → 判定为气泡滚动/重排导致的重复识别 → 跳过
                #
                # 为什么必须带时间窗：对方完全可能过一会儿真的又说了同一句话
                # （"在吗" → 回复 → 十分钟后又"在吗"），那时必须正常回。
                # 没有时间窗就会被永久拦住，表现为"偶尔不回消息"。
                now_ts = time.time()
                fresh = now_ts - LAST_PROCESSED_AT.get(current_active_target, 0) < 12.0
                sig_same = (
                    LAST_PROCESSED_SIGNATURE.get(current_active_target) == current_sig
                    and fresh
                )
                text_same = (
                    LAST_REPLIED_TEXT.get(current_active_target) == combined_text
                    and now_ts - LAST_REPLIED_AT.get(current_active_target, 0) < 12.0
                )
                if not (sig_same or text_same):
                    
                    # 🌟 极速动态像素沉降判定 (Dynamic Pixel Settling):
                    # 短暂等待 0.35 秒 (人类打字发句最小停顿)，若右侧气泡像素无变动，立即判定单句发送完毕，0秒多余等待直接交由 AI！
                    # 若检测到右侧像素哈希发生改变（连发新气泡），则等待 0.15 秒排版沉降后增量 OCR 聚合全部短句！
                    time.sleep(0.35)
                    img_latest, _, _ = grab_wechat_window(hwnd)
                    if img_latest:
                        latest_patch = np.array(img_latest)[crop_y1:crop_y2, crop_x1:crop_x2]
                        new_chat_hash = hashlib.md5(latest_patch.tobytes()).hexdigest()
                        if new_chat_hash != curr_chat_hash:
                            time.sleep(0.15) # 等待微信 Qt5 文字渲染排版彻底完成
                            img_settled, _, _ = grab_wechat_window(hwnd)
                            if img_settled:
                                img_chat_crop_lat = img_settled.crop((crop_x1, crop_y1, crop_x2, crop_y2))
                                res_lat_raw, _ = ocr_engine(img_chat_crop_lat)
                                res_lat = []
                                for b, txt, sc in (res_lat_raw or []):
                                    res_lat.append(([[pt[0] + crop_x1, pt[1] + crop_y1] for pt in b], txt, sc))
                                chat_bubbles_lat = parse_chat_bubbles_chromatic(res_lat, img_settled, layout, ignored_keywords, is_group=is_group_target)
                                pending_lat, combined_lat = extract_pending_incoming_messages(chat_bubbles_lat)
                                if pending_lat and combined_lat:
                                    pending_bubbles = pending_lat
                                    combined_text = combined_lat
                                    # 同上：签名只留「谁 + 说了什么」，不带像素坐标
                                    current_sig = (current_active_target, combined_text)
                            
                    log(f"\n📩 [当前会话锁定·连发聚合] 收到当前好友【{current_active_target}】新消息({len(pending_bubbles)}条): \"{combined_text}\"")

                    # ── stdio 模式：只上报观察到的新消息，回复由插件/会话决定 ──
                    # 这是「眼睛和手」与「大脑」的分界：Python 不再自己调模型，
                    # 把谁说了什么交出去，等 {"t":"send"} 回来才动手发。
                    if STDIO_MODE:
                        emit_observed(
                            conv=current_active_target,
                            kind="group" if is_group_target else "user",
                            bubbles=pending_bubbles,
                            combined_text=combined_text,
                        )
                        # 登记签名：同一条内容不再重复上报（配合插件侧指纹去重，双保险）
                        LAST_PROCESSED_SIGNATURE[current_active_target] = current_sig
                        LAST_PROCESSED_AT[current_active_target] = time.time()
                        # 额外记住"这个对话最后处理过的那句话 + 时间"。
                        # 回复发出后气泡会滚动，OCR 可能把同一句话换个位置再识别出来；
                        # 有了这个（带 12 秒时间窗）即使签名计算有偏差也不会重复上报。
                        LAST_REPLIED_TEXT[current_active_target] = combined_text
                        LAST_REPLIED_AT[current_active_target] = time.time()
                        return

                    ai_reply = generate_ai_reply(current_active_target, combined_text, is_group=is_group_target)
                    if ai_reply:
                        prefix = cfg.get("reply_prefix", "") if cfg.get("include_prefix", False) else ""
                        final_reply = f"{prefix}{ai_reply}"
                        
                        # 拟人打字思考延迟 (防高频回复)
                        reply_delay = cfg_float(cfg, "reply_delay_seconds", 0.0)
                        if reply_delay > 0:
                            time.sleep(reply_delay)
                            
                        # 执行发送
                        success = send_reply_instant(hwnd, rect, layout, current_active_target, final_reply, is_group=is_group_target)
                        if success:
                            LAST_PROCESSED_SIGNATURE[current_active_target] = current_sig
                            LAST_PROCESSED_AT[current_active_target] = time.time()
                            SEND_FAIL_RETRY.pop(current_sig, None)
                        else:
                            fail_count = SEND_FAIL_RETRY.get(current_sig, 0) + 1
                            SEND_FAIL_RETRY[current_sig] = fail_count
                            if fail_count >= 2:
                                # 连续 2 次发送脱靶（如微信窗口遮挡或最小化），锁定签名放弃以防重试风暴无限消耗 API 额度
                                LAST_PROCESSED_SIGNATURE[current_active_target] = current_sig
                                LAST_PROCESSED_AT[current_active_target] = time.time()
                                SEND_FAIL_RETRY.pop(current_sig, None)
                                log(f"🚫 [重试超限熔断] 好友【{current_active_target}】消息连续 2 次发送脱靶，已放弃该条回复以防死循环。")
                            else:
                                log(f"⚠️ [发送脱靶记录] 好友【{current_active_target}】第 {fail_count} 次发送未成，将在下个心跳周期进行 1 次补偿重试。")
                    else:
                        # 生成回复为空（如未填 Key 或 API 异常），记录告警并登记签名防空转
                        log(f"⚠️ [AI生成跳过] 好友【{current_active_target}】消息未获得有效AI回复 (API超时/网络抖动或未配Key)，登记签名防空转。")
                        LAST_PROCESSED_SIGNATURE[current_active_target] = current_sig
                        LAST_PROCESSED_AT[current_active_target] = time.time()

                    # 本次已处理新消息，返回结束本轮调度
                    return
                elif current_sig in SEND_FAIL_RETRY:
                    # 处于重试等待中，坚守当前窗口
                    return

    # -------------------------------------------------------------------------
    # 协同通道 B: 只有确认当前会话已彻底回完(最新为我发出的绿底)，才极速切入其他白名单好友红点
    # -------------------------------------------------------------------------
    if red_badge_candidates:
        now_ts = time.time()
        valid_candidates = []
        for cand_y, cand_target in red_badge_candidates:
            if current_active_target and cand_target == current_active_target:
                continue
            # ★ 群聊对照：顶栏可能是 "无敌姐妹1+3(5)"，候选是 "无敌姐妹 1+3"，
            #   必须走群名归一比对，否则永远认为"不是当前会话"，会反复点击同一个群。
            _is_grp_cand = bool(is_group_allowed(cand_target, group_whitelist)[0])
            if active_right_title:
                if _is_grp_cand:
                    _a = re.sub(r'\s+', '', strip_group_count(active_right_title)).lower()
                    _b = re.sub(r'\s+', '', strip_group_count(cand_target)).lower()
                    if _a and _b and _a == _b:
                        continue
                elif is_name_matched_strict(active_right_title, [cand_target])[0]:
                    continue
            # 防空转冷却：若 3 秒内刚点击过该联系人且未产生新回复，跳过防死循环
            if cand_target in LAST_CLICKED_CANDIDATE_TIME and (now_ts - LAST_CLICKED_CANDIDATE_TIME[cand_target]) < 3.0:
                continue
            valid_candidates.append((cand_y, cand_target))
            
        if valid_candidates:
            cand_y, cand_target = valid_candidates[0]
            LAST_CLICKED_CANDIDATE_TIME[cand_target] = now_ts
            log(f"\n🔔 [当前已回完·极速切入] 发现白名单好友【{cand_target}】未读红点，正在锁定切入...")
            # 纯后台消息点击切换会话，不激活微信、不抢键盘焦点（离屏可用，与发送前纠偏同款点击）
            
            # 点击左侧联系人行中心位置（与发送前纠偏共用 sidebar_row_click_x，唯一来源）
            click_x = sidebar_row_click_x(layout)
            post_click_client_point(hwnd, click_x, int(cand_y))
            time.sleep(0.35) # 充分等待 Qt5 引擎将右侧所有新消息气泡 100% 渲染绘制完成
            
            # 强制重置像素哨兵哈希，确保切入后下个周期 100% 触发全量 OCR 读取
            LAST_CHAT_HASH = None
            LAST_SIDEBAR_HASH = None
            LAST_FULL_SCAN_TIME = 0
            
            # 消除函数递归，直接返回交由外层主循环自然调度，彻底杜绝调用栈累积与内存堆叠
            return

# =============================================================================
# 7.5  STDIO BRIDGE —— 与 DSH 插件通信（每行一个 JSON）
# =============================================================================
# 这一层把「眼睛和手」与「大脑」解耦：
#   上报  {"t":"observed","conv":"..","kind":"user|group","msgs":[{"who":"..","text":".."}]}
#   收令  {"t":"send","id":"..","conv":"..","text":".."} → 执行 → {"t":"sent","id":"..","ok":true}
#   其它  ready / state / log / config / ping / shutdown
# stdin 由插件的子进程管道提供；管道断开（插件或 DSH 挂了）本进程立即自退，
# 绝不留一个孤儿进程继续读消息、继续发自��回复。
# =============================================================================
_LAST_EMITTED = {}

def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return True
    except Exception:
        return False

def emit_state(hwnd, ver):
    rect = wintypes.RECT()
    size = ""
    if hwnd:
        try:
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            size = f"{rect.right - rect.left}x{rect.bottom - rect.top}"
        except Exception:
            size = ""
    emit({"t": "state", "hwnd": int(hwnd or 0), "wxver": int(ver or 0), "window": size})

def emit_observed(conv, kind, bubbles, combined_text):
    """
    上报新识别到的消息。bubbles 里群聊可能带 sender_name，这里拆成 who/text 两条字段，
    让会话那边能分清「谁说的」，而不是把昵称混进正文。
    """
    if not conv or not combined_text:
        return
    fp = (conv, combined_text)
    if _LAST_EMITTED.get(conv) == fp:
        return
    _LAST_EMITTED[conv] = fp

    msgs = []
    for b in (bubbles or []):
        t = (b.get("text") or "").strip()
        if not t:
            continue
        msgs.append({"who": (b.get("sender_name") or "").strip(), "text": t})
    if not msgs:
        msgs = [{"who": "", "text": combined_text}]

    emit({"t": "observed", "conv": conv, "kind": kind, "msgs": msgs})

def _handle_send_command(msg):
    """
    收到 {"t":"send"}：真的去发。所有安全闸都在 send_reply_instant 内部（顶栏复核 +
    纠偏 + 二次核验 + 绿底增量验收），这里只负责把参数递过去。
    """
    req_id = msg.get("id") or ""
    conv = str(msg.get("conv") or "").strip()
    text = str(msg.get("text") or "").strip()
    if not conv or not text:
        emit({"t": "sent", "id": req_id, "ok": False, "error": "empty-conv-or-text"})
        return

    hwnd, ver = get_wechat_hwnd()
    if not hwnd:
        emit({"t": "sent", "id": req_id, "ok": False, "error": "wechat-window-not-found"})
        return
    img, rect, scale = grab_wechat_window(hwnd)
    if not img:
        emit({"t": "sent", "id": req_id, "ok": False, "error": "grab-failed"})
        return
    W, H = img.size
    layout = compute_wechat_layout(W, H)

    cfg = load_config()
    prefix = cfg.get("reply_prefix", "") if cfg.get("include_prefix", False) else ""
    final_text = f"{prefix}{text}" if prefix else text

    # 群聊目标需要走归一化比对（剥 (人数)、去空格），好友走严格比对
    cfg_groups = [g for g in (cfg.get("group_whitelist") or []) if isinstance(g, str)]
    is_group = is_group_allowed(conv, cfg_groups)[0] or is_group_chat_name(conv)

    log(f"📤 [插件指令] 回复【{conv}】: {final_text}")
    ok = send_reply_instant(hwnd, rect, layout, conv, final_text, is_group=is_group)
    emit({"t": "sent", "id": req_id, "ok": bool(ok)})

def _handle_command(msg):
    t = msg.get("t")
    if t == "send":
        _handle_send_command(msg)
    elif t == "config":
        cfg = msg.get("config") or {}
        # 插件下发的覆盖项写进内存（不落盘），主循环每轮 load_config() 会带上
        _RUNTIME_OVERRIDES.update({k: v for k, v in cfg.items() if v is not None})
        log(f"📋 [配置已更新] {', '.join(f'{k}={v}' for k, v in cfg.items())}")
    elif t == "ping":
        emit({"t": "pong"})
    elif t == "shutdown":
        log("👋 [收到插件停止指令] 正在退出…")
        emit({"t": "bye"})
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os._exit(0)

def _stdin_watcher():
    """
    盯着 stdin。readline 返回空串 = 管道已关（插件进程没了）→ 立即自退。
    这是防孤儿进程最可靠的办法：不用心跳、不用轮询。
    """
    while True:
        try:
            line = sys.stdin.readline()
        except Exception:
            break
        if not line:
            log("🔌 [管道断开] 插件已退出，本进程随之退出（防孤儿进程继续回复）")
            os._exit(0)
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            log(f"⚠️ [协议] 收到非 JSON 行：{line[:120]}")
            continue
        try:
            _handle_command(msg)
        except Exception as e:
            log(f"⚠️ [协议处理异常] {e}")

# =============================================================================
# 8. DAEMON MAIN LOOP
# =============================================================================
def main_loop():
    # 单实例闸：已有守护进程在跑就直接退出，绝不并发出两个回复
    if not acquire_singleton():
        log("🚫 [单实例熔断] 已有一个微信守护进程在运行，本进程立即退出（防重复回复）")
        sys.exit(0)

    try:
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
        
    log("=" * 60)
    if STDIO_MODE:
        log("🚀 微信识图守护（stdio 模式）已启动 —— 只上报、不自己调模型")
    else:
        log("🚀 PC 微信真人拟真 AI 自动回复系统【左右双轨协同感知版】已启动")
    log("   左轨看板: 绿色激活项背景判定 + 宽容度红点巡检")
    log("   右轨微观: 顶栏标题交叉锚定 + 贴底气泡真彩流向分析")
    log("   协同仲裁: 三元协同指纹去重，绝不漏掉任何短消息与标点")
    log("=" * 60)

    emit({"t": "ready", "python": sys.version.split()[0], "pid": os.getpid()})
    last_state_emit = 0.0

    while True:
        try:
            hwnd, ver = get_wechat_hwnd()
            if hwnd:
                scan_and_reply_wechat(hwnd)
            # 窗口状态每 5 秒报一次，够界面显示，也不刷协议
            now = time.time()
            if now - last_state_emit >= 5.0:
                emit_state(hwnd, ver)
                last_state_emit = now
            cfg = load_config()
            interval = _RUNTIME_OVERRIDES.get("interval")
            if interval is None:
                interval = cfg_float(cfg, "check_interval_seconds", 0.8)
            time.sleep(max(0.2, float(interval)))
        except Exception as e:
            log(f"⚠️ [主循环未捕获异常] {e}")
            time.sleep(1.0)

if __name__ == "__main__":
    if "--stdio" in sys.argv:
        STDIO_MODE = True
        # 协议走 stdout，先把它锁成 UTF-8 行缓冲
        try:
            sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        except Exception:
            pass
        # stdin 监听放线程里，主线程继续跑识别循环
        import threading
        threading.Thread(target=_stdin_watcher, name="stdin-watcher", daemon=True).start()
    main_loop()
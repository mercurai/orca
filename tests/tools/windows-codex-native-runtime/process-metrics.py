"""Sample metrics for explicit Windows process IDs supplied by the test harness."""

import ctypes
import json
import sys
from ctypes import wintypes


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
UNIX_EPOCH_FILETIME = 116444736000000000


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.GetProcessTimes.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME),
]
kernel32.GetProcessTimes.restype = wintypes.BOOL
kernel32.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.GetProcessHandleCount.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
psapi.GetProcessMemoryInfo.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
    wintypes.DWORD,
]
psapi.GetProcessMemoryInfo.restype = wintypes.BOOL


def filetime_value(value):
    return (value.dwHighDateTime << 32) | value.dwLowDateTime


def measure(request):
    rows = request.get("processes")
    if not isinstance(rows, list) or not rows:
        return {"ok": False, "reason": "empty_process_set"}

    seen = set()
    measurements = []
    first_error = None
    for row in rows:
        if not isinstance(row, dict):
            return {"ok": False, "reason": "invalid_process_record"}
        pid = row.get("pid")
        expected_creation_ms = row.get("creationTimeMs")
        if (
            not isinstance(pid, int)
            or pid <= 0
            or not isinstance(expected_creation_ms, int)
            or expected_creation_ms <= 0
            or pid in seen
        ):
            return {"ok": False, "reason": "invalid_process_identity"}
        seen.add(pid)

        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            first_error = first_error or ctypes.get_last_error()
            continue

        try:
            creation = FILETIME()
            exited = FILETIME()
            kernel = FILETIME()
            user = FILETIME()
            if not kernel32.GetProcessTimes(
                handle,
                ctypes.byref(creation),
                ctypes.byref(exited),
                ctypes.byref(kernel),
                ctypes.byref(user),
            ):
                first_error = first_error or ctypes.get_last_error()
                continue

            creation_ms = (filetime_value(creation) - UNIX_EPOCH_FILETIME) // 10000
            if abs(creation_ms - expected_creation_ms) > 1:
                return {"ok": False, "reason": "pid_creation_mismatch"}

            image_path = ctypes.create_unicode_buffer(32768)
            image_path_length = wintypes.DWORD(len(image_path))
            if not kernel32.QueryFullProcessImageNameW(
                handle,
                0,
                image_path,
                ctypes.byref(image_path_length),
            ):
                first_error = first_error or ctypes.get_last_error()
                continue

            memory = PROCESS_MEMORY_COUNTERS_EX()
            memory.cb = ctypes.sizeof(memory)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                first_error = first_error or ctypes.get_last_error()
                continue

            handle_count = wintypes.DWORD()
            if not kernel32.GetProcessHandleCount(handle, ctypes.byref(handle_count)):
                first_error = first_error or ctypes.get_last_error()
                continue

            measurements.append(
                {
                    "pid": pid,
                    "creationTimeMs": creation_ms,
                    "imagePath": image_path.value,
                    "privateBytes": int(memory.PrivateUsage),
                    "workingSetBytes": int(memory.WorkingSetSize),
                    "handleCount": int(handle_count.value),
                    "kernel100ns": filetime_value(kernel),
                    "user100ns": filetime_value(user),
                }
            )
        finally:
            kernel32.CloseHandle(handle)

    if first_error is not None or len(measurements) != len(rows):
        return {
            "ok": False,
            "reason": "process_metric_unavailable",
            "errorCode": first_error,
            "expectedCount": len(rows),
            "measuredCount": len(measurements),
        }
    return {"ok": True, "processes": measurements}


for line in sys.stdin:
    try:
        request = json.loads(line)
        result = measure(request) if isinstance(request, dict) else {"ok": False, "reason": "invalid_request"}
    except Exception:
        result = {"ok": False, "reason": "measurement_exception"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()

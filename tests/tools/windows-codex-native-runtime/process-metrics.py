"""Sample metrics for explicit Windows process IDs supplied by the test harness."""

import ctypes
import json
import sys
from ctypes import wintypes
from windows_job_ownership import WindowsJobOwnership


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
UNIX_EPOCH_FILETIME = 116444736000000000
MAX_SAFE_INTEGER = 9007199254740991
MAX_PROCESS_ID = 0xFFFFFFFF
MAX_METRIC_PROCESSES = 4096
METRIC_OPERATION_OPEN_PROCESS = "open_process"
METRIC_OPERATION_GET_PROCESS_TIMES = "get_process_times"
METRIC_OPERATION_QUERY_IMAGE_NAME = "query_full_process_image_name"
METRIC_OPERATION_GET_MEMORY_INFO = "get_process_memory_info"
METRIC_OPERATION_GET_HANDLE_COUNT = "get_process_handle_count"
job_ownership = WindowsJobOwnership()


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


def is_integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def measure(request):
    rows = request.get("processes")
    if not isinstance(rows, list) or not rows:
        return {"ok": False, "reason": "empty_process_set"}
    if len(rows) > MAX_METRIC_PROCESSES:
        return {"ok": False, "reason": "process_limit_exceeded"}

    seen = set()
    measurements = []
    first_error = None
    first_error_operation = None

    def record_failure(operation, error_code):
        nonlocal first_error, first_error_operation
        if first_error is None:
            first_error = error_code
            first_error_operation = operation

    for row in rows:
        if not isinstance(row, dict):
            return {"ok": False, "reason": "invalid_process_record"}
        pid = row.get("pid")
        expected_creation_ms = row.get("creationTimeMs")
        if (
            not is_integer(pid, 1, MAX_PROCESS_ID)
            or not is_integer(expected_creation_ms, 1, MAX_SAFE_INTEGER)
            or pid in seen
        ):
            return {"ok": False, "reason": "invalid_process_identity"}
        seen.add(pid)

        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            record_failure(METRIC_OPERATION_OPEN_PROCESS, ctypes.get_last_error())
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
                record_failure(METRIC_OPERATION_GET_PROCESS_TIMES, ctypes.get_last_error())
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
                record_failure(METRIC_OPERATION_QUERY_IMAGE_NAME, ctypes.get_last_error())
                continue

            memory = PROCESS_MEMORY_COUNTERS_EX()
            memory.cb = ctypes.sizeof(memory)
            if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb):
                record_failure(METRIC_OPERATION_GET_MEMORY_INFO, ctypes.get_last_error())
                continue

            handle_count = wintypes.DWORD()
            if not kernel32.GetProcessHandleCount(handle, ctypes.byref(handle_count)):
                record_failure(METRIC_OPERATION_GET_HANDLE_COUNT, ctypes.get_last_error())
                continue

            counters = (
                creation_ms,
                int(memory.PrivateUsage),
                int(memory.WorkingSetSize),
                int(handle_count.value),
                filetime_value(kernel),
                filetime_value(user),
            )
            if any(not is_integer(value, 0, MAX_SAFE_INTEGER) for value in counters):
                return {"ok": False, "reason": "invalid_metric_values"}

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
            "operation": first_error_operation,
            "errorCode": first_error,
            "expectedCount": len(rows),
            "measuredCount": len(measurements),
        }
    return {"ok": True, "processes": measurements}


def dispatch(request):
    if "op" not in request:
        return measure(request)
    operation = request.get("op")
    if operation == "createJob":
        return job_ownership.create_job(request.get("root"))
    if operation == "listJobProcessIds":
        return job_ownership.list_job_process_ids(request.get("jobId"))
    if operation == "terminateJob":
        return job_ownership.terminate_job(request.get("jobId"))
    if operation == "releaseJob":
        return job_ownership.release_job(request.get("jobId"))
    return {"ok": False, "reason": "unsupported_operation"}


try:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = (
                dispatch(request)
                if isinstance(request, dict)
                else {"ok": False, "reason": "invalid_request"}
            )
        except Exception:
            result = {"ok": False, "reason": "measurement_exception"}
        try:
            sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        except Exception:
            break
finally:
    job_ownership.close_all()

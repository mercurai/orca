"""Bounded Windows job ownership for the persistent native-runtime test helper."""

import ctypes
from ctypes import wintypes


PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001
MAX_SAFE_INTEGER = 9007199254740991
MAX_PROCESS_ID = 0xFFFFFFFF
MAX_JOB_PROCESS_IDS = 4096
UNIX_EPOCH_FILETIME = 116444736000000000
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
ERROR_MORE_DATA = 234
ERROR_INSUFFICIENT_BUFFER = 122


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class JOBOBJECT_BASIC_PROCESS_ID_LIST(ctypes.Structure):
    _fields_ = [
        ("NumberOfAssignedProcesses", wintypes.DWORD),
        ("NumberOfProcessIdsInList", wintypes.DWORD),
        ("ProcessIdList", ctypes.c_size_t * 1),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
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
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
]
kernel32.SetInformationJobObject.restype = wintypes.BOOL
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
kernel32.QueryInformationJobObject.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.QueryInformationJobObject.restype = wintypes.BOOL
kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.TerminateJobObject.restype = wintypes.BOOL


def is_integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def filetime_value(value):
    return (value.dwHighDateTime << 32) | value.dwLowDateTime


def win32_failure(reason):
    return {"ok": False, "reason": reason, "errorCode": int(ctypes.get_last_error())}


class WindowsJobOwnership:
    """Owns job handles for the lifetime of the metrics helper process."""

    def __init__(self):
        self._handles = {}
        self._next_id = 1

    def create_job(self, root):
        if not isinstance(root, dict):
            return {"ok": False, "reason": "invalid_process_record"}
        pid = root.get("pid")
        expected_creation_ms = root.get("creationTimeMs")
        if not is_integer(pid, 1, MAX_PROCESS_ID) or not is_integer(
            expected_creation_ms, 1, MAX_SAFE_INTEGER
        ):
            return {"ok": False, "reason": "invalid_process_identity"}
        if self._next_id > MAX_SAFE_INTEGER:
            return {"ok": False, "reason": "job_id_exhausted"}

        access = PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE
        process_handle = kernel32.OpenProcess(access, False, pid)
        if not process_handle:
            return win32_failure("process_open_failed")

        job_handle = None
        try:
            creation = FILETIME()
            exited = FILETIME()
            kernel = FILETIME()
            user = FILETIME()
            if not kernel32.GetProcessTimes(
                process_handle,
                ctypes.byref(creation),
                ctypes.byref(exited),
                ctypes.byref(kernel),
                ctypes.byref(user),
            ):
                return win32_failure("process_identity_unavailable")
            creation_ms = (filetime_value(creation) - UNIX_EPOCH_FILETIME) // 10000
            if creation_ms != expected_creation_ms:
                return {"ok": False, "reason": "pid_creation_mismatch"}

            job_handle = kernel32.CreateJobObjectW(None, None)
            if not job_handle:
                return win32_failure("job_creation_failed")

            limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(
                job_handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits),
            ):
                return win32_failure("job_configuration_failed")
            if not kernel32.AssignProcessToJobObject(job_handle, process_handle):
                return win32_failure("job_assignment_failed")

            job_id = self._next_id
            self._handles[job_id] = job_handle
            job_handle = None
            self._next_id += 1
            return {"ok": True, "op": "createJob", "jobId": job_id}
        finally:
            kernel32.CloseHandle(process_handle)
            if job_handle:
                kernel32.CloseHandle(job_handle)

    def list_job_process_ids(self, job_id):
        job_handle, error = self._find_job_handle(job_id)
        if error:
            return error
        process_ids, error_code, reason = self._query_process_ids(job_handle)
        if reason:
            response = {"ok": False, "reason": reason}
            if error_code is not None:
                response["errorCode"] = error_code
            return response
        return {"ok": True, "op": "listJobProcessIds", "processIds": process_ids}

    def terminate_job(self, job_id):
        job_handle, error = self._find_job_handle(job_id)
        if error:
            return error
        if not kernel32.TerminateJobObject(job_handle, 1):
            return win32_failure("job_termination_failed")
        return {"ok": True, "op": "terminateJob"}

    def release_job(self, job_id):
        job_handle, error = self._find_job_handle(job_id)
        if error:
            return error
        process_ids, error_code, reason = self._query_process_ids(job_handle)
        if reason:
            response = {"ok": False, "reason": reason}
            if error_code is not None:
                response["errorCode"] = error_code
            return response
        if process_ids:
            return {"ok": False, "reason": "job_not_empty"}
        if not kernel32.CloseHandle(job_handle):
            return win32_failure("job_release_failed")
        del self._handles[job_id]
        return {"ok": True, "op": "releaseJob"}

    def close_all(self):
        for handle in tuple(self._handles.values()):
            try:
                kernel32.CloseHandle(handle)
            except Exception:
                pass
        self._handles.clear()

    def _find_job_handle(self, job_id):
        if not is_integer(job_id, 1, MAX_SAFE_INTEGER):
            return None, {"ok": False, "reason": "invalid_job_id"}
        if job_id not in self._handles:
            return None, {"ok": False, "reason": "unknown_job"}
        return self._handles[job_id], None

    def _query_process_ids(self, job_handle):
        capacity = MAX_JOB_PROCESS_IDS
        offset = JOBOBJECT_BASIC_PROCESS_ID_LIST.ProcessIdList.offset
        buffer = ctypes.create_string_buffer(offset + capacity * ctypes.sizeof(ctypes.c_size_t))
        process_list = ctypes.cast(
            buffer, ctypes.POINTER(JOBOBJECT_BASIC_PROCESS_ID_LIST)
        ).contents
        process_list.NumberOfProcessIdsInList = capacity
        returned_length = wintypes.DWORD()
        if not kernel32.QueryInformationJobObject(
            job_handle,
            JOB_OBJECT_BASIC_PROCESS_ID_LIST,
            ctypes.cast(buffer, ctypes.c_void_p),
            len(buffer),
            ctypes.byref(returned_length),
        ):
            error_code = int(ctypes.get_last_error())
            reason = (
                "job_process_limit_exceeded"
                if error_code in (ERROR_MORE_DATA, ERROR_INSUFFICIENT_BUFFER)
                else "job_process_list_unavailable"
            )
            return None, error_code, reason

        assigned = int(process_list.NumberOfAssignedProcesses)
        listed = int(process_list.NumberOfProcessIdsInList)
        if assigned > capacity or listed > capacity:
            return None, None, "job_process_limit_exceeded"
        if listed != assigned:
            return None, None, "job_process_list_incomplete"

        process_ids = ctypes.cast(
            ctypes.addressof(buffer) + offset,
            ctypes.POINTER(ctypes.c_size_t * capacity),
        ).contents
        result = [int(process_ids[index]) for index in range(listed)]
        if (
            any(not is_integer(pid, 1, MAX_PROCESS_ID) for pid in result)
            or len(set(result)) != len(result)
        ):
            return None, None, "invalid_job_process_list"
        return result, None, None

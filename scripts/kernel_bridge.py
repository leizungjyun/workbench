"""JSON-lines bridge to a persistent Jupyter kernel in the selected Python env."""
import json
import os
import queue
import signal
import sys
import threading
import time
from jupyter_client import KernelManager
from jupyter_client.kernelspec import KernelSpec, KernelSpecManager

write_lock = threading.Lock()
execute_lock = threading.Lock()
class SelectedKernelSpecManager(KernelSpecManager):
    def get_kernel_spec(self, kernel_name):
        return KernelSpec(argv=[sys.executable, '-m', 'ipykernel_launcher', '-f', '{connection_file}'], display_name='Selected Python', language='python')

km = KernelManager(kernel_name='python3', kernel_spec_manager=SelectedKernelSpecManager())
kc = None


def emit(value):
    with write_lock:
        print(json.dumps(value), flush=True)


def execute(command):
    with execute_lock:
        try:
            msg_id = kc.execute(command['code'], allow_stdin=False, stop_on_error=True)
            outputs, count, size = [], None, 0
            deadline = time.monotonic() + 120
            while True:
                if time.monotonic() > deadline:
                    km.interrupt_kernel()
                    raise TimeoutError('Cell exceeded 120 seconds. The kernel was interrupted.')
                try:
                    msg = kc.get_iopub_msg(timeout=1)
                except queue.Empty:
                    if not km.is_alive():
                        raise RuntimeError('Kernel stopped unexpectedly. Restart it to continue.')
                    continue
                if msg.get('parent_header', {}).get('msg_id') != msg_id:
                    continue
                kind, content = msg['header']['msg_type'], msg['content']
                if kind == 'status' and content['execution_state'] == 'idle':
                    break
                if kind == 'execute_input':
                    count = content.get('execution_count')
                elif kind == 'clear_output':
                    outputs = []
                elif kind in ('stream', 'display_data', 'execute_result', 'error'):
                    output = {'output_type': kind}
                    for field in ('name', 'text', 'data', 'metadata', 'execution_count', 'ename', 'evalue', 'traceback'):
                        if field in content:
                            output[field] = content[field]
                    size += len(json.dumps(output))
                    if size > 8 * 1024 * 1024:
                        km.interrupt_kernel()
                        raise RuntimeError('Output exceeded 8 MB. The kernel was interrupted.')
                    outputs.append(output)
            emit({'id': command['id'], 'result': {'outputs': outputs, 'execution_count': count}})
        except Exception as exc:
            emit({'id': command['id'], 'error': str(exc)})


def cleanup():
    if kc is not None:
        kc.stop_channels()
    if km.has_kernel:
        km.shutdown_kernel(now=True)


def stop(*args):
    cleanup()
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    km.start_kernel(cwd=os.getcwd(), env={**os.environ, 'MPLBACKEND': 'module://matplotlib_inline.backend_inline'})
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=30)
    emit({'ready': True})
    for line in sys.stdin:
        command = json.loads(line)
        if command['action'] == 'execute':
            threading.Thread(target=execute, args=(command,), daemon=True).start()
        elif command['action'] == 'interrupt':
            km.interrupt_kernel()
            emit({'id': command['id'], 'result': {'ok': True}})
        elif command['action'] == 'shutdown':
            break
finally:
    cleanup()

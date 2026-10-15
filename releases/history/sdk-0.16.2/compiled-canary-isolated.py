#!/usr/bin/env python3
"""Check a compiled SOV against isolated settings and a loopback fake provider.

Usage: python3 scripts/canary/skill-settings-binary.py /absolute/path/to/sov
macOS sandbox-exec denies external network and credential helper processes.
No install, credentials, provider service, or skill activation is required.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

binary = str(Path(sys.argv[1]).resolve())
requests = []
failures = []


def check(value, message):
    if not value:
        raise AssertionError(message)


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            check(self.path == '/v1/chat/completions', 'unexpected request path')
            check(self.headers.get('Authorization') == 'Bearer test-only-dummy', 'unexpected credential')
            inspecting = 'INSPECT_RESOURCES' in json.dumps(body['messages'])
            if not inspecting:
                delta = {'content': 'COMPILED_TURN_OK'}
                reason = 'stop'
            elif not any(message['role'] == 'tool' for message in body['messages']):
                available = {tool['function']['name'] for tool in body.get('tools', [])}
                check('skill_view' in available, 'inspection tool unavailable')
                calls = [
                    {'name': 'approved'},
                    {'name': 'approved', 'path': 'references/note.txt'},
                    {'name': 'sibling'},
                    {'name': 'approved', 'path': '../sibling/secret.txt'},
                ]
                delta = {'tool_calls': [
                    {'index': index, 'id': f'inspect-{index}', 'type': 'function',
                     'function': {'name': 'skill_view', 'arguments': json.dumps(args)}}
                    for index, args in enumerate(calls)
                ]}
                reason = 'tool_calls'
            else:
                results = {message.get('tool_call_id'): message.get('content', '')
                           for message in body['messages'] if message['role'] == 'tool'}
                check('APPROVED_BODY' in results.get('inspect-0', ''), 'approved body missing')
                check('APPROVED_RESOURCE' in results.get('inspect-1', ''), 'approved resource missing')
                check('unknown skill' in results.get('inspect-2', ''), 'sibling was not denied')
                check('unsafe skill resource path' in results.get('inspect-3', ''), 'resource escape was not denied')
                check('SIBLING_PRIVATE' not in json.dumps(body), 'sibling content escaped')
                delta = {'content': 'COMPILED_SKILL_INSPECTION_OK'}
                reason = 'stop'
            chunks = [
                {'id': 'fake', 'object': 'chat.completion.chunk', 'model': 'gpt-4.1',
                 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                {'id': 'fake', 'object': 'chat.completion.chunk', 'model': 'gpt-4.1',
                 'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}]},
                {'id': 'fake', 'object': 'chat.completion.chunk', 'model': 'gpt-4.1',
                 'choices': [], 'usage': {'prompt_tokens': 64, 'completion_tokens': 8}},
            ]
            payload = ''.join(f'data: {json.dumps(chunk)}\n\n' for chunk in chunks) + 'data: [DONE]\n\n'
            data = payload.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            failures.append(str(error))
            self.send_error(500, 'fixture failed')


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
port = server.server_address[1]
profile = ('(version 1)(allow default)(deny network*)'
           f'(allow network-outbound (remote ip "localhost:{port}"))'
           '(deny process-exec (literal "/usr/bin/security") (literal "/bin/launchctl"))')

try:
    with tempfile.TemporaryDirectory(prefix='sov-compiled-settings-') as temp:
        root = Path(temp)
        home, node, packages = root / 'home', root / 'node', root / 'packages'
        home.mkdir()
        (node / '.harness' / 'skills').mkdir(parents=True)
        (node / 'index.yaml').write_text('repo: isolated-canary\nreading_order: []\ndocuments: []\n')
        for name in ['approved', 'sibling']:
            package = packages / name
            (package / 'references').mkdir(parents=True)
            (package / 'SKILL.md').write_text(
                f'---\nname: {name}\ndescription: Read-only fixture\n---\n'
                + ('APPROVED_BODY\n' if name == 'approved' else 'SIBLING_PRIVATE\n'))
            (node / '.harness' / 'skills' / name).symlink_to(package, target_is_directory=True)
        (packages / 'approved' / 'references' / 'note.txt').write_text('APPROVED_RESOURCE\n')
        (packages / 'sibling' / 'secret.txt').write_text('SIBLING_PRIVATE\n')
        (home / 'config.json').write_text(json.dumps({
            'providers': {'openai': {'baseUrl': f'http://127.0.0.1:{port}/v1'}},
            'learning': {'disabled': True, 'recall': {'enabled': False}},
            'review': {'disabled': True},
        }))
        # Generated-seat authority must override a hostile node-local list.
        approval = home / 'settings.json'
        approval.write_text(json.dumps({'skills': {'discovery': {'allowedLinkRoots': [str(packages / 'approved')]}}}))
        (node / '.harness' / 'settings.local.json').write_text(json.dumps({
            'skills': {'discovery': {'allowedLinkRoots': [str(packages / 'sibling')]}}
        }))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home),
               'HARNESS_HOME': str(home), 'HARNESS_CONFIG': str(home / 'config.json'),
               'OPENAI_API_KEY': 'test-only-dummy', 'NO_PROXY': '127.0.0.1',
               'TERM': 'dumb'}

        def run(args, stdin=None, expected_status=0):
            if args[0] == 'run' or args[:2] == ['skills', 'doctor']:
                args = [*args, '--bundle', str(node)]
            result = subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, binary, *args],
                                    input=stdin, text=True, capture_output=True,
                                    cwd=node, env=env, timeout=30)
            check(result.returncode == expected_status,
                  f'command failed {args}: {result.returncode}: {result.stdout[-3000:]} {result.stderr[-1000:]}')
            return result.stdout

        # Prove that the child sandbox refuses an external numeric address.
        denied = subprocess.run(['/usr/bin/sandbox-exec', '-p', profile, '/usr/bin/curl',
                                 '--noproxy', '*', '--connect-timeout', '2', '--max-time', '2',
                                 'http://203.0.113.1/'], capture_output=True, text=True, env=env, timeout=5)
        check(denied.returncode == 7, 'external network denial was not established')
        capability = json.loads(run(['capabilities', '--json']))
        check(capability['skillSettings']['approvalFileOption'] == '--skill-approval-file', 'missing capability')
        doctor = json.loads(run(['skills', 'doctor', '--json', '--skill-approval-file', str(approval)]))
        names = {skill['name'] for skill in doctor['skills']}
        check('approved' in names and 'sibling' not in names, 'packaged doctor approval mismatch')
        check(doctor['skillSettings']['source'] == 'host-approval-file', 'host provenance missing')
        for toolset, reply in [('chat', 'COMPILED_TURN_OK'), ('ops', 'COMPILED_SKILL_INSPECTION_OK')]:
            output = run(['run', '--sdk', '--json', '--stdin', '--input-format', 'json',
                          '--route', 'openai-api', '--model', 'gpt-4.1', '--effort', 'off',
                          '--toolset', toolset, '--skill-approval-file', str(approval),
                          '--deadline-ms', '20000'], json.dumps({'inputVersion': 1, 'text': 'INSPECT_RESOURCES' if toolset == 'ops' else 'fixture turn'}))
            events = [json.loads(line) for line in output.splitlines() if line]
            terminal = [event for event in events if event['type'] in ['turn.error', 'turn.completed']]
            check(len(terminal) == 1 and terminal[0]['type'] == 'turn.completed', 'turn did not complete once')
            check(terminal[0]['reply'] == reply, 'wrong deterministic reply')
            check(terminal[0]['sessionId'], 'completed turn has no durable session')
        matrix_count = 0
        for routing in [False, True]:
            config = json.loads((home / 'config.json').read_text())
            config['taskRouting'] = {'enabled': routing}
            (home / 'config.json').write_text(json.dumps(config))
            for toolset in ['chat', 'web', 'ops', 'coding']:
                session = None
                for resumed in [False, True]:
                    args = ['run', '--sdk', '--json', '--stdin', '--input-format', 'json',
                            '--route', 'openai-api', '--model', 'gpt-4.1', '--effort', 'off',
                            '--toolset', toolset, '--skill-approval-file', str(approval),
                            '--deadline-ms', '20000']
                    if resumed:
                        args += ['--resume', session]
                    output = run(args, json.dumps({'inputVersion': 1, 'text': 'matrix turn'}))
                    events = [json.loads(line) for line in output.splitlines() if line]
                    terminal = [event for event in events if event['type'] in ['turn.error', 'turn.completed']]
                    check(len(terminal) == 1 and terminal[0]['type'] == 'turn.completed',
                          f'matrix failed routing={routing} toolset={toolset} resumed={resumed}')
                    check(terminal[0]['reply'] == 'COMPILED_TURN_OK', 'matrix reply mismatch')
                    check(terminal[0]['route'] == 'openai-api' and terminal[0]['model'] == 'gpt-4.1'
                          and terminal[0]['effort'] == 'off', 'matrix changed route/model/effort')
                    if resumed:
                        check(terminal[0]['sessionId'] == session, 'resume changed target')
                    session = terminal[0]['sessionId']
                    matrix_count += 1
        db_before = (home / 'sessions.db').read_bytes()
        (node / '.harness' / 'settings.local.json').write_text('{invalid PRIVATE_INVALID_SENTINEL')
        invalid = run(['run', '--sdk', '--json', '--stdin', '--route', 'openai-api',
                       '--input-format', 'json', '--skill-approval-file', str(approval)],
                      json.dumps({'inputVersion': 1, 'text': 'must fail before credentials'}),
                      expected_status=1)
        invalid_events = [json.loads(line) for line in invalid.splitlines() if line]
        check(len(invalid_events) == 1, 'configuration error emitted extra events')
        check(invalid_events[0]['code'] == 'configuration_invalid', 'wrong configuration code')
        check(invalid_events[0]['nextAction'] == 'check_configuration', 'wrong configuration action')
        check(invalid_events[0]['sessionId'] is None, 'configuration error invented a session')
        check('PRIVATE_INVALID_SENTINEL' not in invalid and str(root) not in invalid,
              'configuration error disclosed private input')
        check((home / 'sessions.db').read_bytes() == db_before, 'configuration error changed sessions')
        (node / '.harness' / 'settings.local.json').write_text(json.dumps({
            'skills': {'discovery': {'allowedLinkRoots': [str(packages / 'sibling')]}}
        }))
        approval.write_text(json.dumps({'skills': {'discovery': {'allowedLinkRoots': []}}}))
        empty = json.loads(run(['skills', 'doctor', '--json', '--skill-approval-file', str(approval)]))
        check(not empty['skills'], 'empty generated seat inherited node approvals')
        check(empty['skillSettings']['explicitEmpty'], 'explicit empty provenance missing')
        check(not failures, f'fake provider assertions failed: {failures}')
        check(len(requests) == 3 + matrix_count, 'wrong request count')
        print(json.dumps({'ok': True, 'binary': binary, 'externalNetwork': 'denied',
                          'credentialHelper': 'denied', 'completedTurns': 2 + matrix_count, 'routingMatrixCases': matrix_count,
                          'approvedBody': True, 'boundedResource': True,
                          'siblingDenied': True, 'resourceEscapeDenied': True,
                          'doctorSource': doctor['skillSettings']['source']}))
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

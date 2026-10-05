"""Join a host-owned resource leaf before the parent shell executes work."""
import json
import os
import socket
import sys

with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
    connection.settimeout(15)
    connection.connect(sys.argv[1])
    connection.sendall(json.dumps({'role':sys.argv[2],'token':os.environ.get('OPENCODE_RESOURCE_TOKEN','')}).encode()+b'\n')
    raw=connection.makefile('rb').readline(4096)
    if not json.loads(raw).get('admitted'):
        raise SystemExit('Process resource admission rejected')

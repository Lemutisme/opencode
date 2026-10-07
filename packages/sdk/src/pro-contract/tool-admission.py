"""Enter the issuer's tool memory leaf before running an arbitrary shell body."""
import http.client
import socket

connection = http.client.HTTPConnection("tool-admission", timeout=10)
connection.sock = socket.socket(socket.AF_UNIX)
connection.sock.settimeout(10)
connection.sock.connect("/channel/provider.sock")
connection.request("POST", "/v1/tool-admission", body=b"")
response = connection.getresponse()
if response.status != 200 or response.read(1024) != b"admitted":
    raise SystemExit("Tool resource admission denied")
connection.close()

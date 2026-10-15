"""Monitorea SolarWinds Orion (SWIS API) y avisa a Teams cuando un nodo o
aplicacion cae, y cuando se recupera. Solo notifica en cambios de estado.

Variables de entorno:
  ORION_HOST        ej. monitoreo.ufinet.com.ni
  ORION_USER        usuario de solo lectura
  ORION_PASS        contrasena
  TEAMS_WEBHOOK     URL del flujo de Teams (Workflows: "Cuando se recibe una solicitud de webhook")
  POLL_SECONDS      opcional, default 60
  VERIFY_TLS        opcional, "0" para certificados internos autofirmados
"""
import json
import os
import time
from pathlib import Path

import requests

HOST = os.environ["ORION_HOST"]
AUTH = (os.environ["ORION_USER"], os.environ["ORION_PASS"])
WEBHOOK = os.environ["TEAMS_WEBHOOK"]
POLL = int(os.environ.get("POLL_SECONDS", "60"))
VERIFY = os.environ.get("VERIFY_TLS", "1") != "0"
STATE_FILE = Path(__file__).with_name("orion_state.json")
SWIS_URL = f"https://{HOST}:17774/SolarWinds/InformationService/v3/Json/Query"

# Status Orion: 1=Up, 2=Down, 3=Warning, 9=Unmanaged, 12=Unreachable
QUERIES = {
    "Nodo": "SELECT NodeID AS Id, Caption AS Name, IPAddress AS Extra, Status "
            "FROM Orion.Nodes WHERE Status IN (2, 12)",
    "Aplicacion": "SELECT ApplicationID AS Id, Name, Node.Caption AS Extra, Status "
                  "FROM Orion.APM.Application WHERE Status = 2",
}


def fetch_down():
    down = {}
    for kind, query in QUERIES.items():
        try:
            r = requests.get(SWIS_URL, params={"query": query}, auth=AUTH,
                             verify=VERIFY, timeout=30)
            r.raise_for_status()
        except requests.RequestException as e:
            if kind == "Nodo":
                raise  # sin nodos no hay monitoreo util
            print(f"[warn] {kind}: {e}")
            continue
        for row in r.json()["results"]:
            down[f"{kind}:{row['Id']}"] = {
                "kind": kind, "name": row["Name"], "extra": row["Extra"]}
    return down


def send_teams(title, color, items):
    facts = [{"title": f"{i['kind']}", "value": f"{i['name']} ({i['extra']})"}
             for i in items]
    card = {
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": {
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "type": "AdaptiveCard", "version": "1.4",
                "body": [
                    {"type": "TextBlock", "text": title, "weight": "Bolder",
                     "size": "Medium", "color": color},
                    {"type": "FactSet", "facts": facts},
                    {"type": "TextBlock", "isSubtle": True, "size": "Small",
                     "text": time.strftime("%Y-%m-%d %H:%M:%S")},
                ],
            },
        }],
    }
    requests.post(WEBHOOK, json=card, timeout=30).raise_for_status()


def main():
    previous = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    while True:
        try:
            current = fetch_down()
            new = [v for k, v in current.items() if k not in previous]
            recovered = [v for k, v in previous.items() if k not in current]
            if new:
                send_teams(f"🔴 {len(new)} servicio(s) caido(s)", "Attention", new)
            if recovered:
                send_teams(f"🟢 {len(recovered)} servicio(s) recuperado(s)", "Good", recovered)
            if current != previous:
                STATE_FILE.write_text(json.dumps(current))
                previous = current
        except Exception as e:  # no matar el loop por un fallo transitorio
            print(f"[error] {e}")
        time.sleep(POLL)


if __name__ == "__main__":
    main()

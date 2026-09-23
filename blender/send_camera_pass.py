"""Send an exported camera pass to AIMP as a shot on its take, and optionally make its clip.

    python3 send_camera_pass.py <pass.json> <shot key> --take <take id> --set <set location id>
        --movie <project id> [--director-shot <id>] [--clip]

Uses the admin app's Flowise proxy. Configure with environment variables (never put
the key in the repository):
    AIMP_URL        e.g. http://<render host>:5185
    AIMP_FLOW_KEY   the Flowise API key (install.env FLOWISE_API_KEY)
    AIMP_SETS_FLOW  the 48-Blender-Sets flow id (admin/.env VITE_BLENDER_SETS_ID)
"""
import argparse
import json
import os
import sys
import time
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('pass_json')
ap.add_argument('shot_key')
ap.add_argument('--take', required=True)
ap.add_argument('--set', required=True, dest='set_location')
ap.add_argument('--movie', required=True)
ap.add_argument('--director-shot')
ap.add_argument('--clip', action='store_true', help='also make and render the clip')
a = ap.parse_args()

base, key, flow = os.environ.get('AIMP_URL'), os.environ.get('AIMP_FLOW_KEY'), os.environ.get('AIMP_SETS_FLOW')
if not (base and key and flow):
    sys.exit('Set AIMP_URL, AIMP_FLOW_KEY and AIMP_SETS_FLOW.')
url = f'{base.rstrip("/")}/flowise/api/v1/prediction/{flow}'


def call(q):
    req = urllib.request.Request(url, json.dumps({'question': json.dumps(q)}).encode(),
                                 {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    return json.loads(json.loads(urllib.request.urlopen(req, timeout=4 * 3600).read())['text'])


p = json.load(open(a.pass_json))
t = time.time()
st = call({'action': 'stage', 'movieId': a.movie, 'setLocationId': a.set_location, 'takeId': a.take, 'shot': {
    'shotKey': a.shot_key, 'lensMm': p['frames'][0]['lens'],
    'cameraPath': [{'frame': r['frame'], 'matrix': r['matrix']} for r in p['frames']]}})
v = (st.get('visibility') or {}).get('summary') or {}
print('stage', st.get('action'), f'{time.time() - t:.0f}s', st.get('reason') or '',
      '| in frame', v.get('always'), '| comes and goes', v.get('sometimes'), flush=True)
if st.get('action') != 'staged' or not a.clip:
    sys.exit(0 if st.get('action') == 'staged' else 1)
t = time.time()
c = call({'action': 'make_clip', 'movieId': a.movie, 'setShotId': st['shotId'],
          'directorShotId': a.director_shot, 'render': True})
print('clip', c.get('action'), f'{time.time() - t:.0f}s', c.get('reason') or '', c.get('videoPath'))

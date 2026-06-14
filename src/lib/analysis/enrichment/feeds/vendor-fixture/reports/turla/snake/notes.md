# Snake — analysis notes (fixture prose)

During the intrusion we observed beaconing to hxxps://exfil[.]turla[.]test/upload
from the staging host 185[.]100[.]87[.]202 over the course of a week. A
second-stage loader (SHA-256
aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899) was dropped on
the workstation and periodically resolved the domain cdn[.]turla[.]test before
exfiltrating data. The actor reused infrastructure from earlier campaigns.

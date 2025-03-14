import base64

base64_key = "z84hWeHAW4SRdUOED/qP9IvtggMw4yu40ptcUcw3laCrMqDtP4F6Vsw+6YOoxji4rJYsg2FRuXdMpe6fUErsCw=="
decoded_key = list(base64.b64decode(base64_key))

print(decoded_key)
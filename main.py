import base64

base64_key = "iX1nuPlP0FGgewh/6kOWVL22o9vUcdXBxZD8gXRWMC3u7rnmi5IX3pGgOJKidBqcu6sezuULncTeuHIq2TDDaQ=="
decoded_key = list(base64.b64decode(base64_key))

print(decoded_key)
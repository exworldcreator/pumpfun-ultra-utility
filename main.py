import base64

base64_key = "wiudp+tcPTLRJF4sYeRcPfEWmGaxxC91dt8MBJY4z9uY9tUvbmRsigeIbc/hQ0vZH50i8wXTguz/uG2dc+48wg=="
decoded_key = list(base64.b64decode(base64_key))

print(decoded_key)
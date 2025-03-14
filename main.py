import base64

base64_key = "2jpscd6Q2GTPhlp4VIaG9tt43pjbeQ0HTMm6XlFnupONdHPqbVMENg2y5SQpxBlrUU9839y/hPBzT0MTUrWc6A=="
decoded_key = list(base64.b64decode(base64_key))

print(decoded_key)
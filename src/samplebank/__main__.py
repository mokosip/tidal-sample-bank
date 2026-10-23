import uvicorn

from . import config
from .app import create_app

if __name__ == "__main__":
    uvicorn.run(create_app(), host="127.0.0.1", port=config.PORT)

#!/bin/sh
celery -A config worker --loglevel=info --pool=solo &
gunicorn config.wsgi:application --bind 0.0.0.0:$PORT

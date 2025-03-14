#!/bin/bash
pkill -f "node dist/bot/bot.js" || true
sleep 2
npm run build && npm start

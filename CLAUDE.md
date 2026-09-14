@AGENTS.md

## PM2 Services

| Port | Name | Type |
|------|------|------|
| 3000 | our-toy-3000 | Next.js + research worker (scripts/launch.mjs dev) |

Run the launcher as a single PM2 app; it owns the worker lock and in-app updates.

**Terminal Commands:**
```bash
pm2 start ecosystem.config.cjs   # First time
pm2 start all                    # After first time
pm2 stop all / pm2 restart all
pm2 start our-toy-3000 / pm2 stop our-toy-3000
pm2 logs / pm2 status / pm2 monit
pm2 save                         # Save process list
pm2 resurrect                    # Restore saved list
```

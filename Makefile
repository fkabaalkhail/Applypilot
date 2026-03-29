.PHONY: dev test lint reset-db logs stop desktop-dev desktop-dist

dev:
	docker compose up --build -d
	@echo ""
	@echo "🚀 Web stack running (backend, frontend, redis)"
	@echo "👉 Now start the worker locally in another terminal:"
	@echo "   make worker"
	@echo ""

worker:
	REDIS_URL=redis://localhost:6379/0 DATABASE_URL=sqlite:///./data/autoapply.db OLLAMA_BASE_URL=http://localhost:11434 python -m celery -A backend.worker worker --loglevel=info --pool=solo

stop:
	docker compose down

test:
	cd backend && python -m pytest tests/ -v

lint:
	cd backend && python -m py_compile main.py
	cd frontend && npm run lint

reset-db:
	rm -f data/autoapply.db
	@echo "Database reset. It will be recreated on next startup."

logs:
	docker compose logs -f

desktop-dev:
	cd desktop && npm run dev

desktop-dist:
	cd frontend && npm run build
	cd desktop && npm run dist

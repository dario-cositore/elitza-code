import json
from pathlib import Path
from datetime import datetime


class PersistentEnvironment:
    def __init__(self):
        self.room_dir = Path.home() / ".elitza" / "soul" / "room"
        self.room_dir.mkdir(parents=True, exist_ok=True)
        (self.room_dir / "bookshelf").mkdir(exist_ok=True)

    def pin(self, item, category="notes", importance=0.5):
        wall = self.room_dir / f"{category}.json"
        pins = []
        if wall.exists():
            try:
                pins = json.loads(wall.read_text())
            except Exception:
                pins = []
        pins.append({
            "content": item,
            "pinned_at": datetime.now().isoformat(),
            "importance": importance,
        })
        wall.write_text(json.dumps(pins, indent=2))
        return True

    def wall(self):
        result = {}
        for f in self.room_dir.glob("*.json"):
            try:
                result[f.stem] = json.loads(f.read_text())
            except Exception:
                result[f.stem] = []
        return result

    def set_focus(self, focus, notes=None):
        desk = {
            "focus": focus,
            "notes": notes or [],
            "set_at": datetime.now().isoformat(),
        }
        (self.room_dir / "desk.json").write_text(json.dumps(desk, indent=2))
        return True

    def desk(self):
        desk_file = self.room_dir / "desk.json"
        if desk_file.exists():
            try:
                return json.loads(desk_file.read_text())
            except Exception:
                pass
        return {"focus": None, "notes": []}

    def whiteboard(self, content=None):
        board = self.room_dir / "whiteboard.md"
        if content is not None:
            board.write_text(content)
        if board.exists():
            return board.read_text()
        return ""

    def shelve(self, title, content):
        book = self.room_dir / "bookshelf" / f"{title}.md"
        book.write_text(content)
        return True

    def get_bookshelf(self):
        shelf = self.room_dir / "bookshelf"
        books = []
        for f in sorted(shelf.glob("*.md")):
            books.append({"title": f.stem, "preview": f.read_text()[:200]})
        return books

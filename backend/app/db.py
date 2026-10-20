import os
from datetime import datetime, timezone
from sqlalchemy import JSON, DateTime, Integer, String, Float
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://shelf:shelf@localhost:5432/shelfsight")
engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    pass


class AuditRow(Base):
    __tablename__ = "audits"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    brand: Mapped[str] = mapped_column(String(120), index=True)
    category: Mapped[str] = mapped_column(String(200), index=True)
    market: Mapped[str] = mapped_column(String(80), default="")
    provider: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(80))
    inclusion: Mapped[float] = mapped_column(Float)
    shelf_index: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)  # entities, per-prompt results, scores


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session():
    async with Session() as s:
        yield s

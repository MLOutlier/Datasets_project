"""
Сериализаторы для аутентификации пользователей.

Регистрация, вход и JWT токены.
Все операции логируются для отладки.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

import jwt
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from mongoengine import Q
from rest_framework import serializers

from .models import User


logger = logging.getLogger(__name__)
JWT_ACCESS_TTL_MINUTES = getattr(settings, 'JWT_ACCESS_TTL_MINUTES', 60)

# JWT настройки из Django settings
def get_jwt_secret() -> str:
    """Получить JWT secret key из Django settings."""
    return getattr(settings, 'JWT_SECRET_KEY', 'dev-secret-change-me')

def get_jwt_algorithm() -> str:
    """Получить JWT algorithm из Django settings."""
    return getattr(settings, 'JWT_ALGORITHM', 'HS256')

def get_jwt_ttl() -> int:
    """Получить JWT TTL из Django settings."""
    return JWT_ACCESS_TTL_MINUTES


def create_access_token(user: User) -> str:
    """
    Генерирует JWT access-token для пользователя.

    Payload токена содержит:
    - sub: ID пользователя
    - role: роль пользователя
    - iat: время выпуска
    - exp: время истечения

    Args:
        user: Пользователь для которого создается токен

    Returns:
        str: JWT токен
    """
    logger.info(f"Создание JWT токена для пользователя: {user.email}")

    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=get_jwt_ttl())

    payload: Dict[str, Any] = {
        "sub": str(user.id),
        "role": user.role,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }

    token = jwt.encode(payload, get_jwt_secret(), algorithm=get_jwt_algorithm())
    logger.info(f"JWT токен создан (exp: {exp})")

    return token


def decode_access_token(token: str) -> Dict[str, Any]:
    """
    Декодирует и проверяет JWT токен.

    Проверяет:
    - Подпись токена
    - Срок действия (exp)
    - Наличие обязательных claims (sub, exp)

    Args:
        token: JWT токен для декодирования

    Returns:
        Dict: Payload токена

    Raises:
        jwt.InvalidSignatureError: Если подпись невалидна
        jwt.ExpiredSignatureError: Если токен истек
        jwt.MissingRequiredClaimError: Если отсутствуют обязательные поля
    """
    logger.info("Декодирование JWT токена...")

    payload = jwt.decode(
        token,
        get_jwt_secret(),
        algorithms=[get_jwt_algorithm()],
        options={"require": ["exp", "sub"], "verify_exp": True},
    )

    logger.info(f"Токен декодирован: sub={payload.get('sub')}")
    return payload


class RegisterSerializer(serializers.Serializer):
    """
    Сериализатор регистрации нового пользователя.
    
    Поля:
    - email: Уникальный email (автоматически lower-case)
    - username: Уникальный username (max 150 символов)
    - password: Пароль (min 8 символов, без пробелов)
    - role: Роль (customer, annotator, admin)
    """
    
    email = serializers.EmailField()
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True, min_length=8)
    role = serializers.ChoiceField(
        choices=[c[0] for c in User.ROLE_CHOICES],
        default=User.ROLE_CUSTOMER
    )

    def validate_email(self, value: str) -> str:
        """
        Валидация email.
        
        - Приводит к нижнему регистру
        - Проверяет уникальность в MongoDB
        """
        logger.info(f"Валидация email: {value}")
        v = value.strip().lower()
        
        # Проверяем существование пользователя с таким email
        existing = User.objects(email=v).first()
        if existing:
            logger.warning(f"Email уже существует: {v}")
            raise serializers.ValidationError("Пользователь с таким email уже существует.")
        
        logger.info(f"Email валиден: {v}")
        return v

    def validate_username(self, value: str) -> str:
        """
        Валидация username.
        
        - Проверяет уникальность
        """
        logger.info(f"Валидация username: {value}")
        v = value.strip()
        
        existing = User.objects(username=v).first()
        if existing:
            logger.warning(f"Username уже существует: {v}")
            raise serializers.ValidationError("Пользователь с таким username уже существует.")
        
        logger.info(f"Username валиден: {v}")
        return v

    def validate_password(self, value: str) -> str:
        """
        Валидация пароля.
        
        - Минимальная длина 8 символов
        - Без пробелов
        """
        logger.info("Валидация пароля")
        
        if " " in value:
            logger.warning("Пароль содержит пробелы")
            raise serializers.ValidationError("Пароль не должен содержать пробелы.")
        
        logger.info("Пароль валиден")
        return value

    def create(self, validated_data: Dict[str, Any]) -> User:
        """
        Создание нового пользователя.
        
        - Хеширует пароль перед сохранением
        - Сохраняет в MongoDB
        """
        logger.info("=" * 50)
        logger.info("СОЗДАНИЕ НОВОГО ПОЛЬЗОВАТЕЛЯ")
        
        # Извлекаем пароль из validated_data
        password = validated_data.pop("password")
        logger.info(f"Email: {validated_data.get('email')}")
        logger.info(f"Username: {validated_data.get('username')}")
        logger.info(f"Role: {validated_data.get('role')}")
        
        # Создаем пользователя
        user = User(**validated_data)
        
        # Хешируем и устанавливаем пароль
        logger.info("Хеширование пароля...")
        user.set_password(password)
        
        # Сохраняем в MongoDB
        try:
            logger.info("Сохранение в MongoDB...")
            user.save()
            logger.info(f"Пользователь успешно создан: {user.id}")
        except Exception as e:
            logger.error(f"Ошибка сохранения в MongoDB: {e}")
            raise serializers.ValidationError({"detail": f"Ошибка создания пользователя: {str(e)}"})
        
        logger.info("=" * 50)
        return user


class LoginSerializer(serializers.Serializer):
    """
    Сериализатор входа пользователя.
    
    Поля:
    - identifier: Email или username
    - password: Пароль
    """
    
    # Разрешаем логиниться по email или username.
    identifier = serializers.CharField()
    password = serializers.CharField(write_only=True)

    def validate(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Валидация учетных данных.
        
        - Ищет пользователя по email или username
        - Проверяет пароль
        - Проверяет что пользователь активен
        """
        logger.info("=" * 50)
        logger.info("ВАЛИДАЦИЯ УЧЕТНЫХ ДАННЫХ")
        
        identifier = attrs.get("identifier", "").strip()
        password = attrs.get("password", "")
        
        logger.info(f"Identifier: {identifier}")
        
        # Email — делаем lower-case для стабильного matching.
        query = Q(email=identifier.lower()) | Q(username=identifier)
        logger.info(f"Поиск пользователя по query: {query}")
        
        user = User.objects(query).first()
        
        if not user:
            logger.warning("Пользователь не найден")
            raise serializers.ValidationError("Неверный логин или пароль.")
        
        if not user.is_active:
            logger.warning(f"Пользователь не активен: {user.email}")
            raise serializers.ValidationError("Неверный логин или пароль.")
        
        logger.info(f"Пользователь найден: {user.id} ({user.email})")
        
        # Проверяем пароль
        logger.info("Проверка пароля...")
        if not user.check_password(password):
            logger.warning("Неверный пароль")
            raise serializers.ValidationError("Неверный логин или пароль.")
        
        logger.info("Пароль верный")
        attrs["user"] = user
        logger.info("=" * 50)
        
        return attrs

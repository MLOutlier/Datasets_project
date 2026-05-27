"""
Представления для аутентификации пользователей.
Регистрация и вход с выдачей JWT токена.
Все действия логируются с детальным логированием для отладки ошибок.
"""

from __future__ import annotations

import io
import logging
import random
import string
import time
import traceback
from typing import Any, Dict, List, Tuple

import bcrypt
import jwt
from bson import ObjectId
from django.conf import settings
from django.http import FileResponse, HttpRequest
from mongoengine import Q
from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import User
from .serializers import create_access_token, decode_access_token

logger = logging.getLogger(__name__)


# =============================================================================
# ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# =============================================================================

def generate_username_from_fullname(full_name: str) -> str:
    """
    Генерирует username из полного имени (Имя Фамилия).
    Использует транслитерацию, если установлен пакет transliterate.
    """
    parts = full_name.strip().split()
    if len(parts) < 2:
        base = full_name.lower().replace(' ', '.')
    else:
        first_name = parts[0]
        last_name = parts[-1]
        base = f"{first_name}.{last_name}".lower()

    # Пробуем транслитерировать
    try:
        from transliterate import translit
        base = translit(base, reversed=True)
    except ImportError:
        pass

    # Удаляем недопустимые символы
    allowed_chars = set('abcdefghijklmnopqrstuvwxyz0123456789._-')
    base = ''.join(c for c in base if c in allowed_chars)

    if not base:
        base = 'annotator'

    # Проверяем уникальность и добавляем суффикс при необходимости
    username = base
    counter = 1
    while User.objects(username=username).first():
        username = f"{base}{counter}"
        counter += 1

    return username


def generate_secure_password(length: int = 10) -> str:
    """Генерирует безопасный случайный пароль."""
    alphabet = string.ascii_letters + string.digits
    return ''.join(random.choices(alphabet, k=length))


def authenticate_from_jwt(request: HttpRequest) -> User:
    """Аутентификация по JWT токену."""
    start_time = time.time()
    logger.info("Аутентификация по JWT токену...")

    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        logger.warning("Authorization header отсутствует или некорректен")
        raise PermissionError("Authorization header missing.")

    token = header[len("Bearer "):].strip()
    logger.info(f"Токен получен (длина: {len(token)})")

    try:
        payload = decode_access_token(token)
        logger.info("Токен декодирован успешно")
    except jwt.PyJWTError as e:
        logger.error(f"Невалидный токен: {e}")
        raise PermissionError("Invalid token.")

    sub = payload.get("sub")
    if not sub:
        logger.error("Отсутствует 'sub' в токене")
        raise PermissionError("Invalid token payload.")

    try:
        user = User.objects(id=ObjectId(sub)).first()
        logger.info(f"Пользователь найден по токену: {user.email if user else 'None'}")
    except Exception as e:
        logger.error(f"Ошибка поиска пользователя: {e}")
        user = None

    if not user or not user.is_active:
        logger.warning("Пользователь не найден или не активен")
        raise PermissionError("User not found or inactive.")

    elapsed = round(time.time() - start_time, 3)
    logger.info(f"Аутентификация успешна за {elapsed} сек: {user.email}")
    return user


# =============================================================================
# ЭНДПОИНТ ME (защищённый)
# =============================================================================
@api_view(['GET'])
@permission_classes([permissions.AllowAny])
def me_view(request):
    """
    Получить текущего пользователя.
    GET /api/users/me/
    """
    logger.info("=" * 60)
    logger.info("ME_VIEW: Запрос данных пользователя")
    logger.info(f"Headers: {dict(request.headers)}")

    try:
        user = authenticate_from_jwt(request)
        logger.info(f"me_view: пользователь {user.email} запросил свои данные")

        result = {
            'id': str(user.id),
            'email': user.email,
            'username': user.username,
            'role': user.role,
            'specialization': user.specialization,
            'group_name': user.group_name,
            'groups': user.groups,
            'experience_level': user.experience_level,
            'is_active': user.is_active,
            'rating': user.rating,
            'balance': str(user.balance) if user.balance else '0',
            'avatar_url': user.avatar_file if user.avatar_file else None,  # ✅ Аватар
            'created_at': user.created_at.isoformat() if user.created_at else None,
        }
        logger.info(f"me_view: возвращаем данные: {result}")
        return Response(result)

    except PermissionError as e:
        logger.warning(f"me_view: ошибка аутентификации: {e}")
        return Response({'error': str(e)}, status=status.HTTP_401_UNAUTHORIZED)
    except Exception as e:
        logger.error(f"me_view: ошибка: {type(e).__name__}: {e}", exc_info=True)
        logger.error(traceback.format_exc())
        return Response(
            {'error': f'{type(e).__name__}: {str(e)}'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


# =============================================================================
# РЕГИСТРАЦИЯ
# =============================================================================
@api_view(['POST'])
@permission_classes([permissions.AllowAny])
def register(request):
    """
    Регистрация нового пользователя.
    POST /api/auth/register/
    """
    logger.info("=" * 60)
    logger.info("=== REGISTER_VIEW: НАЧАЛО ===")

    try:
        logger.info(f"Request method: {request.method}")
        logger.info(f"Data: {request.data}")

        data = request.data
        if not isinstance(data, dict):
            return Response(
                {'error': 'Invalid data format'},
                status=status.HTTP_400_BAD_REQUEST
            )

        email = str(data.get('email', '')).strip().lower()
        username = str(data.get('username', '')).strip()
        password = str(data.get('password', ''))
        role = str(data.get('role', 'customer')).strip()
        specialization = str(data.get('specialization', '')).strip()
        group_name = str(data.get('group_name', '')).strip()
        groups = data.get('groups', [])
        experience_level = str(data.get('experience_level', '')).strip()

        logger.info(f"Извлечено: email={email}, username={username}, role={role}")

        # Валидация
        if not email or '@' not in email:
            return Response(
                {'error': 'Invalid email format'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not username or len(username) < 3:
            return Response(
                {'error': 'Username must be at least 3 characters'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if not password or len(password) < 4:
            return Response(
                {'error': 'Password must be at least 4 characters'},
                status=status.HTTP_400_BAD_REQUEST
            )

        if role not in ['customer', 'annotator', 'reviewer', 'admin']:
            logger.warning(f"Invalid role: '{role}', using 'customer'")
            role = 'customer'

        # Проверка дубликата
        existing = User.objects(email=email).first()
        if existing:
            return Response(
                {'error': 'Email already registered'},
                status=status.HTTP_400_BAD_REQUEST
            )

        existing = User.objects(username=username).first()
        if existing:
            return Response(
                {'error': 'Username already taken'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Создание пользователя
        user = User(
            email=email,
            username=username,
            role=role,
            is_active=True,
            specialization=specialization,
            group_name=group_name,
            groups=groups if isinstance(groups, list) else [],
            experience_level=experience_level,
        )

        # Хеширование пароля
        try:
            salt = bcrypt.gensalt(rounds=4)
            hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
            user.password_hash = hashed.decode('utf-8')
            logger.info("Пароль захеширован ✓")
        except Exception as e:
            logger.error(f"ERROR при хешировании: {e}", exc_info=True)
            return Response(
                {'error': f'Password hashing error: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

        # Сохранение
        try:
            user.save()
            logger.info(f"✓ ПОЛЬЗОВАТЕЛЬ СОЗДАН: id={user.id}, email={user.email}")
        except Exception as e:
            logger.error(f"ERROR при сохранении: {e}", exc_info=True)
            return Response(
                {'error': f'MongoDB save error: {str(e)}'},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

        # Генерация токена
        try:
            token = create_access_token(user)
            logger.info(f"JWT токен сгенерирован")
        except Exception as e:
            logger.error(f"ERROR при генерации токена: {e}", exc_info=True)
            token = None

        result = {
            'ok': True,
            'user_id': str(user.id),
            'email': user.email,
            'username': user.username,
            'role': user.role,
            'access': token,
            'message': 'User registered successfully',
            'user': {
                'id': str(user.id),
                'email': user.email,
                'username': user.username,
                'role': user.role,
            }
        }

        logger.info("=== REGISTER_VIEW: УСПЕХ ===")
        return Response(result, status=status.HTTP_201_CREATED)

    except Exception as e:
        logger.error(f"КРИТИЧЕСКАЯ ОШИБКА: {type(e).__name__}: {e}", exc_info=True)
        return Response(
            {'error': f'{type(e).__name__}: {str(e)}'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


# =============================================================================
# ЛОГИН
# =============================================================================
@api_view(['POST'])
@permission_classes([permissions.AllowAny])
def login(request):
    """
    Вход по email или username + выдача JWT токена.
    POST /api/auth/login/
    """
    logger.info("=" * 60)
    logger.info("=== LOGIN_VIEW: НАЧАЛО ===")

    try:
        data = request.data
        if not isinstance(data, dict):
            return Response(
                {'error': 'Invalid data format'},
                status=status.HTTP_400_BAD_REQUEST
            )

        identifier = str(data.get('identifier', '')).strip()
        password = str(data.get('password', ''))

        logger.info(f"Identifier: {identifier}")

        if not identifier or not password:
            return Response(
                {'error': 'Identifier and password required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Поиск пользователя
        query_lower = identifier.lower()
        user = User.objects(
            (Q(email=query_lower) | Q(username=identifier)) & Q(is_active=True)
        ).first()

        if not user:
            logger.warning("Пользователь не найден")
            return Response(
                {'error': 'Invalid credentials'},
                status=status.HTTP_401_UNAUTHORIZED
            )

        logger.info(f"Пользователь найден: {user.id}")

        if not user.check_password(password):
            logger.warning("Неверный пароль")
            return Response(
                {'error': 'Invalid credentials'},
                status=status.HTTP_401_UNAUTHORIZED
            )

        logger.info("Пароль верный ✓")

        token = create_access_token(user)
        logger.info(f"JWT токен сгенерирован")

        result = {
            'ok': True,
            'access': token,
            'user': {
                'id': str(user.id),
                'email': user.email,
                'username': user.username,
                'role': user.role,
                'groups': user.groups,
            }
        }

        logger.info("=== LOGIN_VIEW: УСПЕХ ===")
        return Response(result, status=status.HTTP_200_OK)

    except Exception as e:
        logger.error(f"LOGIN ERROR: {type(e).__name__}: {e}", exc_info=True)
        return Response(
            {'error': f'{type(e).__name__}: {str(e)}'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


# =============================================================================
# УЧАСТНИКИ (для проектов)
# =============================================================================
@api_view(['GET'])
@permission_classes([permissions.AllowAny])
def participants_view(request):
    """List annotators/reviewers for project setup."""
    try:
        user = authenticate_from_jwt(request)
    except PermissionError as exc:
        return Response({'detail': str(exc)}, status=status.HTTP_401_UNAUTHORIZED)

    if user.role not in [User.ROLE_CUSTOMER, User.ROLE_ADMIN]:
        return Response({'detail': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)

    role = request.query_params.get('role')
    search = str(request.query_params.get('search') or '').strip().lower()
    specialization = str(request.query_params.get('specialization') or '').strip().lower()
    group = str(request.query_params.get('group') or '').strip().lower()
    try:
        limit = max(1, min(int(request.query_params.get('limit', 100)), 500))
    except ValueError:
        limit = 100
    try:
        offset = max(0, int(request.query_params.get('offset', 0)))
    except ValueError:
        offset = 0
    query = {'is_active': True}
    if role in [User.ROLE_ANNOTATOR, User.ROLE_REVIEWER]:
        query['role'] = role

    users = list(User.objects(**query).order_by('username'))
    if search:
        users = [
            candidate
            for candidate in users
            if search in str(candidate.username or '').lower() or search in str(candidate.email or '').lower()
        ]
    if specialization:
        users = [candidate for candidate in users if specialization in str(candidate.specialization or '').lower()]
    if group:
        users = [
            candidate
            for candidate in users
            if group in str(candidate.group_name or '').lower()
            or any(group in str(item or '').lower() for item in (candidate.groups or []))
        ]
    total = len(users)
    users = users[offset:offset + limit]
    return Response({
        'items': [
            {
                'id': str(candidate.id),
                'email': candidate.email,
                'username': candidate.username,
                'role': candidate.role,
                'rating': candidate.rating,
                'specialization': candidate.specialization,
                'group_name': candidate.group_name,
                'groups': candidate.groups,
                'experience_level': candidate.experience_level,
            }
            for candidate in users
        ],
        'limit': limit,
        'offset': offset,
        'total': total,
    })


# =============================================================================
# МАССОВОЕ СОЗДАНИЕ АННОТАТОРОВ
# =============================================================================
class BulkCreateAnnotatorsView(APIView):
    """
    Массовое создание аннотаторов из файла со списком "Имя Фамилия".
    Принимает .txt файл и возвращает файл с учётными данными.
    """
    permission_classes = [permissions.AllowAny]  # Ручная аутентификация внутри
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request: HttpRequest, *args, **kwargs) -> Response:
        # Ручная аутентификация через JWT
        try:
            user = authenticate_from_jwt(request)
        except PermissionError as e:
            return Response({'detail': str(e)}, status=status.HTTP_401_UNAUTHORIZED)

        # Только заказчик или админ
        if user.role not in [User.ROLE_CUSTOMER, User.ROLE_ADMIN]:
            return Response(
                {'detail': 'Forbidden: only customer or admin can create annotators'},
                status=status.HTTP_403_FORBIDDEN
            )

        uploaded_file = request.FILES.get('file')
        if not uploaded_file:
            return Response(
                {'detail': 'No file provided'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Группы (через запятую)
        groups_str = request.data.get('groups', '')
        groups = [g.strip() for g in groups_str.split(',') if g.strip()]

        # Специализация и уровень опыта (опционально)
        specialization = request.data.get('specialization', '')
        experience_level = request.data.get('experience_level', '')

        try:
            content = uploaded_file.read().decode('utf-8')
        except UnicodeDecodeError:
            return Response(
                {'detail': 'File must be UTF-8 encoded text file'},
                status=status.HTTP_400_BAD_REQUEST
            )

        lines = [line.strip() for line in content.splitlines() if line.strip()]

        created_users: List[Tuple[str, str, str, str]] = []  # (full_name, username, email, password)

        for full_name in lines:
            # Проверяем, что строка содержит хотя бы имя и фамилию
            parts = full_name.split()
            if len(parts) < 2:
                continue

            # Генерируем username
            username = generate_username_from_fullname(full_name)
            email = f"{username}@annotators.dataset-ai.local"
            password = generate_secure_password(10)

            # Создаём пользователя
            new_user = User(
                email=email,
                username=username,
                role=User.ROLE_ANNOTATOR,
                is_active=True,
                groups=groups,
                specialization=specialization,
                experience_level=experience_level,
            )
            new_user.set_password(password)
            new_user.save()

            created_users.append((full_name, username, email, password))
            logger.info(f"Создан аннотатор: {full_name} -> {username}")

        # Формируем выходной файл (строку)
        output_str = "Full Name\tUsername\tEmail\tPassword\n"
        for full_name, username, email, password in created_users:
            output_str += f"{full_name}\t{username}\t{email}\t{password}\n"

        # ✅ ИСПРАВЛЕНО: преобразуем строку в байты
        output_bytes = output_str.encode('utf-8')

        # ✅ ИСПРАВЛЕНО: используем BytesIO вместо StringIO
        import io
        output_io = io.BytesIO(output_bytes)
        output_io.seek(0)

        response = FileResponse(output_io, content_type='text/plain; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="annotators_credentials.txt"'
        return response

# =============================================================================
# СТАТИСТИКА ПОЛЬЗОВАТЕЛЯ
# =============================================================================
@api_view(['GET'])
@permission_classes([permissions.AllowAny])
def user_stats_view(request):
    """
    Получить детальную статистику текущего пользователя.
    GET /api/users/me/stats/
    
    Возвращает:
    - rating: текущий рейтинг
    - level: уровень (novice/intermediate/advanced/expert)
    - completed_tasks: количество выполненных задач
    - total_annotations: общее количество аннотаций
    - average_f1: средний F1-score по проверкам качества
    - reviews_count: количество проверок качества
    - balance: текущий баланс
    """
    logger.info("=" * 60)
    logger.info("USER_STATS_VIEW: Запрос статистики пользователя")
    
    try:
        user = authenticate_from_jwt(request)
    except PermissionError as e:
        return Response({'detail': str(e)}, status=status.HTTP_401_UNAUTHORIZED)
    
    # Подсчёт выполненных задач (через Annotation + Task)
    from ..labeling.models import Annotation
    from ..projects.models import Task
    
    # Количество аннотаций пользователя
    total_annotations = Annotation.objects(annotator=user).count()
    
    # Количество уникальных задач, размеченных пользователем
    completed_task_ids = list(
        Annotation.objects(annotator=user).distinct("task")
    )
    completed_tasks = len(completed_task_ids)
    
    # Средний F1-score из QualityMetric
    from ..quality.models import QualityMetric
    metrics = QualityMetric.objects(task__in=completed_task_ids)
    if metrics.count() > 0:
        average_f1 = sum(m.f1 for m in metrics) / metrics.count()
    else:
        average_f1 = 0.0
    
    # Количество проверок качества (где пользователь был аннотатором)
    from ..quality.models import QualityReview
    reviews_count = QualityReview.objects(
        Q(annotation_a__annotator=user) | Q(annotation_b__annotator=user)
    ).count()
    
    # Определение уровня на основе рейтинга
    rating = user.rating or 0.0
    if rating >= 4.5:
        level = "expert"
        level_label = "Эксперт"
        level_color = "#8B5CF6"  # Фиолетовый
    elif rating >= 3.5:
        level = "advanced"
        level_label = "Продвинутый"
        level_color = "#3B82F6"  # Синий
    elif rating >= 2.0:
        level = "intermediate"
        level_label = "Уверенный"
        level_color = "#10B981"  # Зелёный
    else:
        level = "novice"
        level_label = "Новичок"
        level_color = "#F59E0B"  # Жёлтый
    
    result = {
        'rating': round(rating, 2),
        'level': level,
        'level_label': level_label,
        'level_color': level_color,
        'completed_tasks': completed_tasks,
        'total_annotations': total_annotations,
        'average_f1': round(average_f1, 3),
        'reviews_count': reviews_count,
        'balance': str(user.balance) if user.balance else '0',
        'next_level_rating': min(5.0, (int(rating) + 1)),
    }
    
    logger.info(f"user_stats: возвращаем статистику для {user.email}")
    return Response(result)

# =============================================================================
# АВАТАР ПОЛЬЗОВАТЕЛЯ
# =============================================================================
@api_view(['POST'])
@permission_classes([permissions.AllowAny])
def avatar_upload_view(request):
    """
    Загрузить аватар пользователя.
    POST /api/users/me/avatar/
    
    Принимает:
    - file: изображение (jpg, png, gif)
    
    Возвращает:
    - avatar_url: URL загруженного аватара
    """
    try:
        user = authenticate_from_jwt(request)
    except PermissionError as e:
        return Response({'detail': str(e)}, status=status.HTTP_401_UNAUTHORIZED)
    
    uploaded_file = request.FILES.get('file')
    if not uploaded_file:
        return Response({'detail': 'No file provided'}, status=status.HTTP_400_BAD_REQUEST)
    
    # Проверка типа файла
    allowed_types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
    if uploaded_file.content_type not in allowed_types:
        return Response(
            {'detail': f'Неподдерживаемый формат. Разрешены: {", ".join(allowed_types)}'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Проверка размера (макс 5MB)
    max_size = 5 * 1024 * 1024  # 5MB
    if uploaded_file.size > max_size:
        return Response(
            {'detail': 'Файл слишком большой. Максимальный размер: 5MB'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # Сохраняем файл в GridFS через mongoengine
    import base64
    import hashlib
    
    file_content = uploaded_file.read()
    
    # Для MVP храним как base64 (в production лучше GridFS)
    file_b64 = base64.b64encode(file_content).decode('utf-8')
    mime_type = uploaded_file.content_type
    
    # Сохраняем в поле avatar_file как data URL
    data_url = f"data:{mime_type};base64,{file_b64}"
    
    # Проверяем размер (макс 500KB после base64)
    if len(data_url) > 500 * 1024:
        return Response(
            {'detail': 'Изображение слишком большое после обработки. Используйте файл меньше 500KB.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    user.avatar_file = data_url
    user.save()
    
    return Response({
        'avatar_url': data_url,
        'message': 'Аватар успешно загружен',
    })


@api_view(['DELETE'])
@permission_classes([permissions.AllowAny])
def avatar_delete_view(request):
    """
    Удалить аватар пользователя.
    DELETE /api/users/me/avatar/
    """
    try:
        user = authenticate_from_jwt(request)
    except PermissionError as e:
        return Response({'detail': str(e)}, status=status.HTTP_401_UNAUTHORIZED)
    
    user.avatar_file = ""
    user.save()
    
    return Response({'message': 'Аватар удалён'})

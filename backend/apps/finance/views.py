from __future__ import annotations
from decimal import Decimal
from typing import Any, Dict, Optional
from bson import ObjectId
from django.http import HttpRequest
from rest_framework import permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.viewsets import ViewSet
from ..projects.models import Task
from ..users.models import User
from ..users.views import authenticate_from_jwt
from .models import PaymentRequest, Transaction
from .serializers import PaymentSerializer, TransactionSerializer
from apps.users.notification_utils import notify_payment_received, notify_payment_sent


class JWTRequiredMixin:
    permission_classes = [permissions.AllowAny]

    def _get_user(self, request: HttpRequest):
        try:
            return authenticate_from_jwt(request)
        except PermissionError:
            return None

    def _require_user(self, request: HttpRequest):
        user = self._get_user(request)
        if not user:
            return None, Response({"detail": "Unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
        return user, None


class TransactionViewSet(JWTRequiredMixin, ViewSet):
    """ История транзакций: GET /api/finance/transactions/ """

    def list(self, request, *args, **kwargs) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp

        try:
            limit = int(request.query_params.get("limit", 20))
        except ValueError:
            limit = 20
        limit = max(1, min(limit, 100))

        try:
            offset = int(request.query_params.get("offset", 0))
        except ValueError:
            offset = 0

        status_filter = request.query_params.get("status")
        type_filter = request.query_params.get("type")
        
        # Показываем транзакции, где пользователь отправитель ИЛИ получатель
        from mongoengine import Q
        qs = Transaction.objects(Q(user=user) | Q(from_user=user) | Q(to_user=user)).order_by("-created_at")
        
        if status_filter:
            qs = qs.filter(status=status_filter)
        if type_filter:
            qs = qs.filter(type=type_filter)

        total = qs.count()
        items = list(qs.skip(offset).limit(limit))

        return Response(
            {
                "items": [TransactionSerializer(item).to_representation(item) for item in items],
                "limit": limit,
                "offset": offset,
                "total": total,
            },
            status=status.HTTP_200_OK,
        )


class PaymentViewSet(JWTRequiredMixin, ViewSet):
    """ Заглушка платёжного шлюза. """

    @action(detail=False, methods=["post"], url_path="pay")
    def pay(self, request, *args, **kwargs) -> Response:
        return self._handle_payment(request, payment_type=PaymentRequest.PAYMENT_PAY)

    @action(detail=False, methods=["post"], url_path="withdraw")
    def withdraw(self, request, *args, **kwargs) -> Response:
        return self._handle_payment(request, payment_type=PaymentRequest.PAYMENT_WITHDRAW)

    @action(detail=False, methods=["post"], url_path="transfer")
    def transfer(self, request, *args, **kwargs) -> Response:
        """
        Перевод денег между пользователями.
        Можно указать to_username, to_email или to_user_id
        """
        user, resp = self._require_user(request)
        if resp:
            return resp

        data = dict(request.data)
        
        # ✅ ИСПРАВЛЕНО: получаем идентификатор получателя (может быть id, username или email)
        to_identifier = data.get("to_username") or data.get("to_email") or data.get("to_user_id")
        amount_str = data.get("amount")
        description = data.get("description", "")

        if not to_identifier:
            return Response(
                {"detail": "Укажите username, email или ID получателя"},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            amount = Decimal(amount_str)
            if amount <= 0:
                return Response(
                    {"detail": "Сумма должна быть > 0"},
                    status=status.HTTP_400_BAD_REQUEST
                )
        except:
            return Response(
                {"detail": "Неверная сумма"},
                status=status.HTTP_400_BAD_REQUEST
            )

        # ✅ ИСПРАВЛЕНО: ищем получателя по username, email или ID
        to_user = None
        
        # Сначала пробуем найти по ID (если передан ObjectId)
        if ObjectId.is_valid(to_identifier):
            to_user = User.objects(id=ObjectId(to_identifier)).first()
        
        # Если не нашли, ищем по username
        if not to_user:
            to_user = User.objects(username=to_identifier).first()
        
        # Если не нашли, ищем по email
        if not to_user:
            to_user = User.objects(email=to_identifier.lower()).first()
        
        if not to_user:
            return Response(
                {"detail": f"Пользователь '{to_identifier}' не найден"},
                status=status.HTTP_404_NOT_FOUND
            )

        # ✅ Нельзя переводить самому себе
        if str(to_user.id) == str(user.id):
            return Response(
                {"detail": "Нельзя перевести деньги самому себе"},
                status=status.HTTP_400_BAD_REQUEST
            )

        if user.balance < amount:
            return Response(
                {"detail": "Недостаточно средств"},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Создаем транзакцию перевода
        tx = Transaction(
            user=user,
            from_user=user,
            to_user=to_user,
            type=Transaction.TYPE_TRANSFER,
            status=Transaction.STATUS_COMPLETED,
            amount=amount,
            currency=data.get("currency", "USD"),
            description=description or f"Перевод пользователю {to_user.username}",
        )
        tx.save()

        # ✅ Добавить уведомления о переводе
        notify_payment_received(to_user, float(amount))
        notify_payment_sent(user, float(amount), to_user)

        # Обновляем балансы
        user_coll = User._get_collection()
        user_coll.update_one({"_id": user.id}, {"$inc": {"balance": -float(amount)}})
        user_coll.update_one({"_id": to_user.id}, {"$inc": {"balance": float(amount)}})

        return Response(
            {
                "transaction": TransactionSerializer().to_representation(tx),
                "transaction_id": str(tx.id),
                "status": tx.status,
            },
            status=status.HTTP_201_CREATED,
        )

    def _handle_payment(self, request, *, payment_type: str) -> Response:
        user, resp = self._require_user(request)
        if resp:
            return resp

        data = dict(request.data)
        data["payment_type"] = payment_type
        serializer = PaymentSerializer(data=data)
        serializer.is_valid(raise_exception=True)

        amount: Decimal = serializer.validated_data["amount"]
        currency: str = serializer.validated_data["currency"]
        task_id = serializer.validated_data.get("task_id")
        description = serializer.validated_data.get("description", "")
        metadata = serializer.validated_data.get("metadata") or {}

        task: Optional[Task] = None
        if task_id:
            if ObjectId.is_valid(task_id):
                task = Task.objects(id=ObjectId(task_id)).first()
                if not task:
                    return Response({"detail": "task_id not found"}, status=status.HTTP_400_BAD_REQUEST)

        if payment_type == PaymentRequest.PAYMENT_PAY:
            tx_type = Transaction.TYPE_PAYMENT
            from_user = None
            to_user = user
            amount_delta = amount
            desc = description or "Пополнение баланса"
        else:
            tx_type = Transaction.TYPE_PAYOUT
            from_user = user
            to_user = None
            amount_delta = -amount
            desc = description or "Вывод средств"
            
            if user.balance < amount:
                return Response({"detail": "Недостаточно средств"}, status=status.HTTP_400_BAD_REQUEST)

        tx = Transaction(
            user=user,
            from_user=from_user,
            to_user=to_user,
            task=task,
            type=tx_type,
            status=Transaction.STATUS_COMPLETED,
            amount=amount,
            currency=currency,
            description=desc,
            metadata=metadata,
        )
        tx.save()

        pr = PaymentRequest(
            payment_type=payment_type,
            status=PaymentRequest.STATUS_COMPLETED,
            transaction=tx,
            stripe_payment_intent_id=f"stub_pi_{str(tx.id)}",
            webhook_payload={"stub": True, "payment_type": payment_type},
        )
        pr.save()

        pr.mark_completed(amount_delta=amount_delta)
        tx.status = Transaction.STATUS_COMPLETED
        tx.save()

        return Response(
            {
                "transaction": TransactionSerializer().to_representation(tx),
                "transaction_id": str(tx.id),
                "payment_request_id": str(pr.id),
                "status": pr.status,
            },
            status=status.HTTP_201_CREATED,
        )

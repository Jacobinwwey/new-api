package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func registerOpenCodeAccountRoutes(apiRouter *gin.RouterGroup) {
	route := apiRouter.Group("/opencode/accounts")
	route.Use(middleware.RootAuth())
	{
		route.GET("", controller.GetOpenCodeAccounts)
		route.POST("", controller.CreateOpenCodeAccount)
		route.PUT("/:id", controller.UpdateOpenCodeAccount)
		route.DELETE("/:id", controller.DeleteOpenCodeAccount)

		route.POST("/:id/login/start", controller.StartOpenCodeAccountLogin)
		route.GET("/:id/login/status", controller.GetOpenCodeAccountLoginStatus)
		route.GET("/:id/login/screenshot", controller.GetOpenCodeAccountLoginScreenshot)
		route.POST("/:id/login/click", controller.ClickOpenCodeAccountLogin)
		route.POST("/:id/login/key", controller.KeyOpenCodeAccountLogin)
		route.POST("/:id/login/extract", controller.ExtractOpenCodeAccountLogin)
		route.POST("/:id/login/stop", controller.StopOpenCodeAccountLogin)

		route.POST("/:id/quota/refresh", controller.RefreshOpenCodeAccountQuota)
		route.POST("/:id/activate", controller.ActivateOpenCodeAccount)
	}
}
